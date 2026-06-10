package kolm

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Schema and signature-block markers a kolm audit report declares. These mirror
// the constants in src/attestation-report-builder.js / src/ed25519.js and
// public/kolm-audit-verify.js exactly.
const (
	// AuditReportSchema is the value of the top-level `schema` field.
	AuditReportSchema = "kolm-audit-report-1"
	// Ed25519Spec is the value of signature_ed25519.spec.
	Ed25519Spec = "kolm-ed25519-v1"
	// Ed25519Alg is the value of signature_ed25519.alg.
	Ed25519Alg = "ed25519"
)

// Check is a single, named step in a verification, recording whether it passed
// and a short human-readable detail. It mirrors the `checks` array returned by
// the JS verifiers so a Go caller can render the same step-by-step report.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// Verdict is the outcome of [VerifyReport]. The two tiers are independent:
//
//   - Tier1Signature is true when the embedded Ed25519 key signed the exact
//     canonical payload (the report is untampered).
//   - Tier2Issuer is true when that embedded key is a known kolm issuer (it
//     matches an entry in the keyring passed to VerifyReport).
//
// A report should only be acted on when [Verdict.Trusted] is true: Tier1 alone
// proves "signed by the holder of THIS key, untampered" — an attacker can re-sign
// a tampered report with their OWN key and still pass Tier1. Tier2 is what binds
// the key to kolm.
type Verdict struct {
	Tier1Signature bool   `json:"tier1_signature"`
	Tier2Issuer    bool   `json:"tier2_issuer"`
	KeyFingerprint string `json:"key_fingerprint"`
	Reason         string `json:"reason"`

	// Issuer details, populated only when Tier2Issuer is true.
	IssuerKID    string `json:"issuer_kid,omitempty"`
	IssuerLabel  string `json:"issuer_label,omitempty"`
	IssuerStatus string `json:"issuer_status,omitempty"`

	// Checks is the ordered list of verification steps that were run.
	Checks []Check `json:"checks,omitempty"`
}

// Trusted reports whether the report is both cryptographically valid AND signed
// by a recognized kolm issuer. This is the only boolean a consumer should gate
// on.
func (v Verdict) Trusted() bool { return v.Tier1Signature && v.Tier2Issuer }

// VerifyReport verifies a signed kolm audit-report envelope entirely offline.
//
// envelope is the raw report JSON bytes (the .json deliverable a buyer received).
// keyring is the set of trusted kolm issuers to check the embedded key against;
// pass [DefaultKeyring] for the keys kolm publishes, or a custom slice (e.g.
// pinned to the production issuer only).
//
// The error/Verdict split is deliberate and idiomatic:
//
//   - A non-nil error means the input could not be verified at all — it is not
//     valid JSON, not an object, carries an unexpected schema, has no usable
//     signature block, or embeds a key/signature that cannot be decoded. In
//     these cases the returned Verdict is the zero value and MUST be ignored.
//   - A nil error means verification ran to completion; inspect the Verdict.
//     Tier1Signature may still be false (bad signature, fingerprint mismatch, or
//     a post-signing timestamp edit) and Tier2Issuer may be false (unknown key).
//
// A caller that treats "err != nil OR !verdict.Trusted()" as "do not trust" is
// always safe. VerifyReport never panics and never performs I/O.
func VerifyReport(envelope []byte, keyring []Issuer) (Verdict, error) {
	report, err := ParseReport(envelope)
	if err != nil {
		return Verdict{}, err
	}

	var verdict Verdict

	// schema (if present, it must be ours).
	if raw, ok := report["schema"]; ok && raw != nil {
		s, _ := looseString(raw)
		if s != "" && s != AuditReportSchema {
			return Verdict{}, fmt.Errorf("kolm: unexpected schema %q (want %q)", s, AuditReportSchema)
		}
		verdict.Checks = append(verdict.Checks, Check{"schema", true, s})
	} else {
		verdict.Checks = append(verdict.Checks, Check{"schema", true, "(none)"})
	}

	// signature_ed25519 block.
	blockRaw, ok := report["signature_ed25519"]
	if !ok || blockRaw == nil {
		return Verdict{}, errors.New("kolm: report has no signature_ed25519 block")
	}
	block, ok := blockRaw.(map[string]any)
	if !ok {
		return Verdict{}, errors.New("kolm: signature_ed25519 is not a JSON object")
	}

	// spec / alg, if present, must match.
	if raw, ok := block["spec"]; ok && raw != nil {
		if s, _ := looseString(raw); s != "" && s != Ed25519Spec {
			return Verdict{}, fmt.Errorf("kolm: unexpected signature spec %q (want %q)", s, Ed25519Spec)
		}
	}
	if raw, ok := block["alg"]; ok && raw != nil {
		if s, _ := looseString(raw); s != "" && s != Ed25519Alg {
			return Verdict{}, fmt.Errorf("kolm: unexpected signature alg %q (want %q)", s, Ed25519Alg)
		}
	}
	verdict.Checks = append(verdict.Checks, Check{
		"signature_block_present", true,
		fmt.Sprintf("alg=%s spec=%s", stringOr(block["alg"], "?"), stringOr(block["spec"], "?")),
	})

	pemKey, ok := stringField(block, "public_key")
	if !ok || pemKey == "" {
		return Verdict{}, errors.New("kolm: signature block missing public_key")
	}
	sigB64, ok := stringField(block, "signature")
	if !ok || sigB64 == "" {
		return Verdict{}, errors.New("kolm: signature block missing signature")
	}

	pub, der, err := parseEd25519PublicKeyPEM(pemKey)
	if err != nil {
		return Verdict{}, fmt.Errorf("kolm: cannot read public_key: %w", err)
	}
	fp := keyFingerprintFromDER(der)
	verdict.KeyFingerprint = fp

	// Tier 2 — issuer provenance is a pure key comparison, independent of the
	// signature, so compute it up front. It only carries meaning together with
	// Tier1Signature (see the Verdict / Trusted docs).
	if iss, found := MatchIssuer(pemKey, keyring); found {
		verdict.Tier2Issuer = true
		verdict.IssuerKID = iss.KID
		verdict.IssuerLabel = iss.Label
		verdict.IssuerStatus = iss.Status
		verdict.Checks = append(verdict.Checks, Check{"issuer_recognized", true,
			fmt.Sprintf("%s (%s)", iss.KID, iss.Status)})
	} else {
		verdict.Checks = append(verdict.Checks, Check{"issuer_recognized", false,
			"embedded key is not in the trusted issuer keyring"})
	}

	// Rebuild the exact signed bytes (report minus its own signature block).
	canonical := CanonicalizeReport(report)
	verdict.Checks = append(verdict.Checks, Check{"canonical_payload_rebuilt", true,
		fmt.Sprintf("%d bytes", len(canonical))})

	// Cross-check the claimed fingerprint against the actual public-key bytes.
	if claim, has := looseString(block["key_fingerprint"]); has && claim != "" && claim != fp {
		verdict.Reason = "key_fingerprint claim does not match public_key bytes"
		verdict.Checks = append(verdict.Checks, Check{"key_fingerprint", false,
			fmt.Sprintf("claimed %s vs actual %s", truncate(claim, 12), truncate(fp, 12))})
		return verdict, nil
	}
	verdict.Checks = append(verdict.Checks, Check{"key_fingerprint", true, fp})

	// Decode the base64url signature and run the real Ed25519 verification.
	sig, err := decodeBase64URL(sigB64)
	if err != nil {
		verdict.Reason = "signature is not valid base64url: " + err.Error()
		verdict.Checks = append(verdict.Checks, Check{"ed25519_signature", false, verdict.Reason})
		return verdict, nil
	}
	if len(sig) != ed25519.SignatureSize {
		verdict.Reason = fmt.Sprintf("signature is %d bytes, want %d", len(sig), ed25519.SignatureSize)
		verdict.Checks = append(verdict.Checks, Check{"ed25519_signature", false, verdict.Reason})
		return verdict, nil
	}
	if !ed25519.Verify(pub, canonical, sig) {
		verdict.Reason = "Ed25519 signature does not verify against the canonical payload"
		verdict.Checks = append(verdict.Checks, Check{"ed25519_signature", false, "signature does NOT match payload"})
		return verdict, nil
	}
	verdict.Checks = append(verdict.Checks, Check{"ed25519_signature", true, "signature matches payload"})

	// signed_at lives in the signature block, which the signature does NOT cover;
	// generated_at IS in the signed payload. signReport sets them equal, so a
	// mismatch means the displayed timestamp was edited after signing — surface
	// it rather than show a clean pass over a forged date.
	signedAt, hasSignedAt := looseString(block["signed_at"])
	genAt, hasGenAt := looseString(report["generated_at"])
	if hasSignedAt && hasGenAt && signedAt != genAt {
		verdict.Tier1Signature = false
		verdict.Reason = "signed_at does not match the signed generated_at (timestamp altered after signing)"
		verdict.Checks = append(verdict.Checks, Check{"signed_at_consistency", false,
			fmt.Sprintf("block.signed_at=%s != generated_at=%s", signedAt, genAt)})
		return verdict, nil
	}
	verdict.Checks = append(verdict.Checks, Check{"signed_at_consistency", true, genAt})

	verdict.Tier1Signature = true
	if verdict.Tier2Issuer {
		verdict.Reason = "signed by a recognized kolm issuer; payload untampered"
	} else {
		verdict.Reason = "signature is valid but the embedded key is not in the trusted issuer keyring"
	}
	return verdict, nil
}

// ParseReport decodes report bytes into the generic JSON tree the canonicalizer
// operates on. It uses json.Number so numeric tokens are not prematurely coerced
// to float64 with a divergent formatting; [Canonicalize] applies the ECMAScript
// number formatting itself.
func ParseReport(envelope []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(envelope))
	dec.UseNumber()
	var root any
	if err := dec.Decode(&root); err != nil {
		return nil, fmt.Errorf("kolm: report is not valid JSON: %w", err)
	}
	m, ok := root.(map[string]any)
	if !ok {
		return nil, errors.New("kolm: report must be a JSON object")
	}
	return m, nil
}

// ---------------------------------------------------------------------------
// Canonicalization — MUST stay byte-identical to canonicalize() in
// src/attestation-report-builder.js and public/kolm-audit-verify.js.
//
// Recursive, key-sorted, whitespace-free JSON. The output is the exact byte
// string the Ed25519 signature covers (after UTF-8 encoding, which a Go string's
// in-memory bytes already are).
// ---------------------------------------------------------------------------

// Canonicalize serializes a JSON-native value (as produced by [ParseReport] /
// json.Unmarshal with UseNumber: map[string]any, []any, json.Number, string,
// bool, nil) into the canonical bytes the signature covers. Plain Go numeric and
// bool/string values are also accepted; any other type is normalized through
// encoding/json once and re-canonicalized.
func Canonicalize(value any) []byte {
	return appendCanonical(make([]byte, 0, 256), value)
}

// detachedReportFields are the four envelope keys the Ed25519 signature does
// NOT cover, excluded byte-for-byte in lockstep with canonicalizeReport() in
// src/attestation-report-builder.js and public/kolm-audit-verify.js:
//   - signature_ed25519: a signature cannot cover itself.
//   - timestamp_evidence + log_checkpoint: detached evidence (RFC 3161 TSA /
//     append-only witness) attached AFTER signing; each references the signed
//     digest, so it binds to the report without being covered by the signature.
//   - co_signatures: named-reviewer Ed25519 blocks added AFTER the primary
//     signature, each over THIS same canonical payload.
// Stripping only signature_ed25519 made every real report (the builder always
// attaches log_checkpoint) fail Go verification while Node/browser passed.
var detachedReportFields = map[string]struct{}{
	"signature_ed25519": {},
	"timestamp_evidence": {},
	"log_checkpoint":     {},
	"co_signatures":      {},
}

// CanonicalizeReport strips the four detached fields (the signature cannot cover
// itself, and the TSA / witness / co-signer blocks are attached after signing)
// and canonicalizes the remainder, mirroring canonicalizeReport() in the Node
// and browser code. The input map is not modified.
func CanonicalizeReport(report map[string]any) []byte {
	rest := make(map[string]any, len(report))
	for k, v := range report {
		if _, detached := detachedReportFields[k]; detached {
			continue
		}
		rest[k] = v
	}
	return Canonicalize(rest)
}

func appendCanonical(b []byte, v any) []byte {
	switch val := v.(type) {
	case nil:
		return append(b, "null"...)
	case bool:
		if val {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case string:
		return appendJSONString(b, val)
	case json.Number:
		// Match JS: every JSON number is parsed to an IEEE-754 double and then
		// formatted via the ECMAScript Number-to-String algorithm. ParseFloat
		// over- / under-flows to +Inf / 0 exactly as JSON.parse does, and
		// ecmaFormatNumber maps non-finite values to "null" like the JS
		// Number.isFinite guard.
		f, err := strconv.ParseFloat(val.String(), 64)
		if err != nil {
			if errors.Is(err, strconv.ErrRange) {
				// Overflow/underflow: ParseFloat still set f to ±Inf or 0.
				return append(b, ecmaFormatNumber(f)...)
			}
			return append(b, "null"...)
		}
		return append(b, ecmaFormatNumber(f)...)
	case float64:
		return append(b, ecmaFormatNumber(val)...)
	case float32:
		return append(b, ecmaFormatNumber(float64(val))...)
	case int:
		return strconv.AppendInt(b, int64(val), 10)
	case int8:
		return strconv.AppendInt(b, int64(val), 10)
	case int16:
		return strconv.AppendInt(b, int64(val), 10)
	case int32:
		return strconv.AppendInt(b, int64(val), 10)
	case int64:
		return strconv.AppendInt(b, val, 10)
	case uint:
		return strconv.AppendUint(b, uint64(val), 10)
	case uint8:
		return strconv.AppendUint(b, uint64(val), 10)
	case uint16:
		return strconv.AppendUint(b, uint64(val), 10)
	case uint32:
		return strconv.AppendUint(b, uint64(val), 10)
	case uint64:
		return strconv.AppendUint(b, val, 10)
	case []any:
		b = append(b, '[')
		for i, e := range val {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendCanonical(b, e)
		}
		return append(b, ']')
	case map[string]any:
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sortKeysUTF16(keys)
		b = append(b, '{')
		for i, k := range keys {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendJSONString(b, k)
			b = append(b, ':')
			b = appendCanonical(b, val[k])
		}
		return append(b, '}')
	default:
		// Arbitrary Go value (struct, typed map/slice): normalize through JSON
		// once so it becomes the native tree above, then re-canonicalize. The
		// final bytes are still produced by our own emitter, so number/string
		// formatting stays byte-exact.
		if norm, ok := normalizeViaJSON(v); ok {
			return appendCanonical(b, norm)
		}
		return append(b, "null"...)
	}
}

func normalizeViaJSON(v any) (any, bool) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var out any
	if err := dec.Decode(&out); err != nil {
		return nil, false
	}
	return out, true
}

// appendJSONString reproduces ECMAScript's QuoteJSONString (the escaping
// JSON.stringify applies to strings) EXACTLY. Critically it does NOT escape
// "<", ">", "&" (Go's encoding/json escapes these by default) nor U+2028 /
// U+2029 (Go's encoding/json escapes these too). Only ", \, and the C0 control
// characters are escaped; everything else — including all non-ASCII — passes
// through as raw UTF-8 bytes, matching the JS signer.
func appendJSONString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\b':
			b = append(b, '\\', 'b')
		case '\t':
			b = append(b, '\\', 't')
		case '\n':
			b = append(b, '\\', 'n')
		case '\f':
			b = append(b, '\\', 'f')
		case '\r':
			b = append(b, '\\', 'r')
		default:
			if c < 0x20 {
				b = append(b, '\\', 'u', '0', '0', hexLower(c>>4), hexLower(c&0xf))
			} else {
				// Raw byte: ASCII >= 0x20 or any UTF-8 multibyte unit (>= 0x80).
				// None of those collide with the cases above, so byte-wise
				// iteration reconstructs the original UTF-8 exactly.
				b = append(b, c)
			}
		}
	}
	return append(b, '"')
}

func hexLower(n byte) byte {
	if n < 10 {
		return '0' + n
	}
	return 'a' + (n - 10)
}

// ecmaFormatNumber reproduces ECMAScript's Number::toString (ES2023 6.1.6.1.20),
// the algorithm JSON.stringify uses for numbers, so the canonical bytes match the
// Node and browser signer byte-for-byte. Both Go's strconv (precision -1) and
// ECMAScript emit the SHORTEST round-trip decimal digits; the only thing that
// differs between languages is the notation (when to switch to exponential and
// how to lay out the point), which this function re-derives explicitly.
func ecmaFormatNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		// ECMAScript stringifies both +0 and -0 to "0".
		return "0"
	}
	neg := false
	if f < 0 {
		neg = true
		f = -f
	}
	// Shortest round-trip digits + decimal exponent, e.g. "5.788e+01", "5e+00".
	rep := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, expStr, _ := strings.Cut(rep, "e")
	exp, _ := strconv.Atoi(expStr)                  // exponent of the leading digit
	digits := strings.Replace(mantissa, ".", "", 1) // significant digits, no point
	k := len(digits)                                // count of significant digits
	n := exp + 1                                    // position of the decimal point

	var sb strings.Builder
	if neg {
		sb.WriteByte('-')
	}
	switch {
	case k <= n && n <= 21:
		// Integer with trailing zeros: digits then (n-k) zeros.
		sb.WriteString(digits)
		sb.WriteString(strings.Repeat("0", n-k))
	case 0 < n && n <= 21:
		// Decimal point inside the digit run.
		sb.WriteString(digits[:n])
		sb.WriteByte('.')
		sb.WriteString(digits[n:])
	case -6 < n && n <= 0:
		// 0.00…digits
		sb.WriteString("0.")
		sb.WriteString(strings.Repeat("0", -n))
		sb.WriteString(digits)
	default:
		// Exponential: d[.ddd]e±(n-1)
		sb.WriteByte(digits[0])
		if k > 1 {
			sb.WriteByte('.')
			sb.WriteString(digits[1:])
		}
		sb.WriteByte('e')
		e := n - 1
		if e >= 0 {
			sb.WriteByte('+')
		} else {
			sb.WriteByte('-')
			e = -e
		}
		sb.WriteString(strconv.Itoa(e))
	}
	return sb.String()
}

// sortKeysUTF16 sorts object keys by UTF-16 code unit, reproducing JavaScript's
// default Array.prototype.sort comparator (which compares strings by UTF-16 code
// unit). For all-ASCII keys this equals byte order, but for keys containing
// supplementary-plane characters (e.g. emoji) UTF-16 surrogate pairs sort
// differently from UTF-8 bytes — so we compare code units, not bytes, to stay
// byte-identical to the JS signer for every possible key set.
func sortKeysUTF16(keys []string) {
	sort.SliceStable(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
}

func lessUTF16(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	n := len(ua)
	if len(ub) < n {
		n = len(ub)
	}
	for i := 0; i < n; i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// ---------------------------------------------------------------------------
// Key parsing, fingerprint, and issuer provenance.
// ---------------------------------------------------------------------------

func parseEd25519PublicKeyPEM(pemStr string) (ed25519.PublicKey, []byte, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, nil, errors.New("no PEM block found")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse SPKI DER: %w", err)
	}
	edPub, ok := pub.(ed25519.PublicKey)
	if !ok {
		return nil, nil, fmt.Errorf("public key is %T, want ed25519", pub)
	}
	return edPub, block.Bytes, nil
}

// KeyFingerprintFromPEM returns the kolm key fingerprint of an Ed25519 public-key
// PEM: the first 32 hex chars (128 bits) of SHA-256 over the SPKI DER. It matches
// keyFingerprint() in src/ed25519.js byte-for-byte and is useful for pinning a
// report to a key you fetched from GET /v1/audit/issuer-key.
func KeyFingerprintFromPEM(pemStr string) (string, error) {
	_, der, err := parseEd25519PublicKeyPEM(pemStr)
	if err != nil {
		return "", err
	}
	return keyFingerprintFromDER(der), nil
}

func keyFingerprintFromDER(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])[:32]
}

// MatchIssuer returns the keyring entry whose public key equals publicKeyPEM
// (compared with PEM whitespace ignored), mirroring issuerProvenance() in
// public/kolm-audit-verify.js. The boolean reports whether a match was found.
func MatchIssuer(publicKeyPEM string, keyring []Issuer) (Issuer, bool) {
	target := stripJSWhitespace(publicKeyPEM)
	if target == "" {
		return Issuer{}, false
	}
	for _, iss := range keyring {
		if iss.PublicKey != "" && stripJSWhitespace(iss.PublicKey) == target {
			return iss, true
		}
	}
	return Issuer{}, false
}

// stripJSWhitespace removes every character JavaScript's \s matches, so PEM
// equality is insensitive to line-ending and trailing-newline differences
// exactly as normalizePem() does in the browser verifier.
func stripJSWhitespace(s string) string {
	return strings.Map(func(r rune) rune {
		if isJSWhitespace(r) {
			return -1
		}
		return r
	}, s)
}

// isJSWhitespace reports whether r is in the exact set JavaScript's \s matches:
// the C0 whitespace (tab, LF, VT, FF, CR), space, NBSP, and the Unicode space
// separators plus U+FEFF (BOM). Numeric code points are used so the source has
// no ambiguous literal whitespace.
func isJSWhitespace(r rune) bool {
	switch r {
	case 0x0009, // CHARACTER TABULATION
		0x000A, // LINE FEED
		0x000B, // LINE TABULATION
		0x000C, // FORM FEED
		0x000D, // CARRIAGE RETURN
		0x0020, // SPACE
		0x00A0, // NO-BREAK SPACE
		0x1680, // OGHAM SPACE MARK
		0x2000, // EN QUAD
		0x2001, // EM QUAD
		0x2002, // EN SPACE
		0x2003, // EM SPACE
		0x2004, // THREE-PER-EM SPACE
		0x2005, // FOUR-PER-EM SPACE
		0x2006, // SIX-PER-EM SPACE
		0x2007, // FIGURE SPACE
		0x2008, // PUNCTUATION SPACE
		0x2009, // THIN SPACE
		0x200A, // HAIR SPACE
		0x2028, // LINE SEPARATOR
		0x2029, // PARAGRAPH SEPARATOR
		0x202F, // NARROW NO-BREAK SPACE
		0x205F, // MEDIUM MATHEMATICAL SPACE
		0x3000, // IDEOGRAPHIC SPACE
		0xFEFF: // ZERO WIDTH NO-BREAK SPACE (BOM)
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

func decodeBase64URL(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	return base64.RawURLEncoding.DecodeString(s)
}

// stringField returns the value of key as a string only when it is actually a
// JSON string.
func stringField(m map[string]any, key string) (string, bool) {
	v, ok := m[key]
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

// looseString coerces any non-nil JSON value to a string, mirroring JS String().
// The second return is false only when the value is absent / nil.
func looseString(v any) (string, bool) {
	switch x := v.(type) {
	case nil:
		return "", false
	case string:
		return x, true
	case json.Number:
		return x.String(), true
	case bool:
		if x {
			return "true", true
		}
		return "false", true
	case float64:
		return ecmaFormatNumber(x), true
	default:
		return fmt.Sprintf("%v", x), true
	}
}

func stringOr(v any, fallback string) string {
	if s, ok := looseString(v); ok && s != "" {
		return s
	}
	return fallback
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
