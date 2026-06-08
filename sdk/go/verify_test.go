package kolm

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
)

const sampleReportPath = "testdata/sample-report.json"

// The demo issuer that signs the committed sample report.
const (
	demoFingerprint = "410302c93becdcc3a8091ef0c33c24ed"
	demoKID         = "kolm-demo-2026"
	demoPEM         = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAcNW1vj5BUnzmEjH6iAdKM2p5of35Oe6znRifqpuLF7A=\n-----END PUBLIC KEY-----\n"
)

func readSample(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(sampleReportPath)
	if err != nil {
		t.Fatalf("read sample report: %v", err)
	}
	return data
}

// ---------------------------------------------------------------------------
// Canonicalization fidelity.
// ---------------------------------------------------------------------------

func TestEcmaFormatNumber(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{math.Copysign(0, -1), "0"}, // -0 stringifies to "0"
		{5, "5"},
		{50, "50"},
		{100, "100"},
		{0.5, "0.5"},
		{1.5, "1.5"},
		{12.5, "12.5"},
		{57.88, "57.88"},
		{-3.25, "-3.25"},
		{1000000, "1000000"},
		{123456789, "123456789"},
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"},
		{1e-6, "0.000001"},
		{1e-7, "1e-7"},
		{math.Inf(1), "null"},
		{math.Inf(-1), "null"},
		{math.NaN(), "null"},
	}
	for _, c := range cases {
		if got := ecmaFormatNumber(c.in); got != c.want {
			t.Errorf("ecmaFormatNumber(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCanonicalizeStringEscaping(t *testing.T) {
	// kolm does NOT escape <, >, &, or / (Go's encoding/json would). Quotes,
	// backslashes and C0 controls ARE escaped; non-ASCII passes through raw.
	in := "a\"b\\c\n\t<>&/é😀"
	want := "\"a\\\"b\\\\c\\n\\t<>&/é😀\""
	if got := string(Canonicalize(in)); got != want {
		t.Errorf("Canonicalize(string) = %q, want %q", got, want)
	}
}

func TestCanonicalizeControlChars(t *testing.T) {
	// U+0000 and U+001F have no short escape, so they become the six-character
	// lowercase \u00XX form; U+007F is >= 0x20 so it passes through raw.
	in := "\x00\x1f\x7f"
	want := "\"\\u0000\\u001f\x7f\""
	if got := string(Canonicalize(in)); got != want {
		t.Errorf("Canonicalize(control) = %q, want %q", got, want)
	}
}

func TestCanonicalizeObjectKeySortAndNumbers(t *testing.T) {
	// Parse with UseNumber so numbers travel the json.Number -> float64 path the
	// verifier actually uses, then assert key-sorted, whitespace-free output.
	in := []byte(`{"z":0,"a":[true,null,"x"],"m":0.5,"big":1000000,"neg":-2}`)
	report, err := ParseReport(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	want := `{"a":[true,null,"x"],"big":1000000,"m":0.5,"neg":-2,"z":0}`
	if got := string(Canonicalize(report)); got != want {
		t.Errorf("Canonicalize(object) = %q, want %q", got, want)
	}
}

func TestCanonicalizeNullAndEmpty(t *testing.T) {
	cases := map[string]string{
		`{"a":null,"b":{},"c":[]}`: `{"a":null,"b":{},"c":[]}`,
		`[]`:                       `[]`,
		`{}`:                       `{}`,
	}
	for in, want := range cases {
		var v any
		dec := json.NewDecoder(strings.NewReader(in))
		dec.UseNumber()
		if err := dec.Decode(&v); err != nil {
			t.Fatalf("decode %s: %v", in, err)
		}
		if got := string(Canonicalize(v)); got != want {
			t.Errorf("Canonicalize(%s) = %q, want %q", in, got, want)
		}
	}
}

func TestLessUTF16SupplementaryPlane(t *testing.T) {
	// U+1F600 (the grinning-face emoji) is a supplementary character: in UTF-16
	// it begins with the high surrogate 0xD83D, which sorts BELOW the BMP char
	// U+FFFF (0xFFFF). A naive UTF-8 byte comparison would order them the other
	// way. The verifier must match JavaScript's UTF-16 ordering.
	emoji := "\U0001F600"
	bmp := "￿"
	if !lessUTF16(emoji, bmp) {
		t.Errorf("lessUTF16(emoji, U+FFFF) = false, want true (UTF-16 code-unit order)")
	}
	if lessUTF16(bmp, emoji) {
		t.Errorf("lessUTF16(U+FFFF, emoji) = true, want false")
	}
	// ASCII order is unaffected.
	if !lessUTF16("1", "Z") || !lessUTF16("Z", "a") || !lessUTF16("a", "b") {
		t.Errorf("ASCII ordering broken")
	}
}

func TestCanonicalizeStructNormalization(t *testing.T) {
	// A non-JSON-native Go value normalizes through encoding/json once, then
	// re-canonicalizes with our own emitter (so <, & stay raw and keys sort).
	type inner struct {
		Z int    `json:"z"`
		A string `json:"a<b>"`
	}
	got := string(Canonicalize(inner{Z: 7, A: "x&y"}))
	want := `{"a<b>":"x&y","z":7}`
	if got != want {
		t.Errorf("Canonicalize(struct) = %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// Offline verification - the killer feature.
// ---------------------------------------------------------------------------

func TestVerifyReportValidSample(t *testing.T) {
	// This is the load-bearing test: the sample was signed by the Node builder
	// over its canonical bytes. If the Go canonicalizer diverged by a single
	// byte, the Ed25519 check below would fail. A pass proves byte-for-byte
	// agreement with the reference implementation.
	v, err := VerifyReport(readSample(t), DefaultKeyring())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !v.Tier1Signature {
		t.Fatalf("Tier1Signature = false, want true; reason=%q", v.Reason)
	}
	if !v.Tier2Issuer {
		t.Errorf("Tier2Issuer = false, want true")
	}
	if !v.Trusted() {
		t.Errorf("Trusted() = false, want true")
	}
	if v.KeyFingerprint != demoFingerprint {
		t.Errorf("KeyFingerprint = %q, want %q", v.KeyFingerprint, demoFingerprint)
	}
	if v.IssuerKID != demoKID {
		t.Errorf("IssuerKID = %q, want %q", v.IssuerKID, demoKID)
	}
	if v.IssuerStatus != "demo" {
		t.Errorf("IssuerStatus = %q, want %q", v.IssuerStatus, "demo")
	}
}

func TestVerifyReportTamperedPayload(t *testing.T) {
	report, err := ParseReport(readSample(t))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Alter a field inside the signed payload.
	subj, ok := report["subject"].(map[string]any)
	if !ok {
		t.Fatalf("subject is %T, want object", report["subject"])
	}
	subj["name"] = "Tampered fleet"
	tampered, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	v, err := VerifyReport(tampered, DefaultKeyring())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v.Tier1Signature {
		t.Errorf("Tier1Signature = true on tampered payload, want false")
	}
	if v.Trusted() {
		t.Errorf("Trusted() = true on tampered payload, want false")
	}
	if !strings.Contains(v.Reason, "does not verify") {
		t.Errorf("Reason = %q, want it to mention the signature mismatch", v.Reason)
	}
}

func TestVerifyReportSignedAtTamper(t *testing.T) {
	report, err := ParseReport(readSample(t))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// signed_at lives OUTSIDE the signed payload, so editing it keeps the
	// Ed25519 signature valid - but it no longer matches generated_at, which is
	// signed. The verifier must catch this.
	block := report["signature_ed25519"].(map[string]any)
	block["signed_at"] = "1999-01-01T00:00:00.000Z"
	edited, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	v, err := VerifyReport(edited, DefaultKeyring())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v.Tier1Signature {
		t.Errorf("Tier1Signature = true after signed_at edit, want false")
	}
	if !strings.Contains(v.Reason, "signed_at") {
		t.Errorf("Reason = %q, want it to mention signed_at", v.Reason)
	}
}

func TestVerifyReportUnknownIssuer(t *testing.T) {
	// The signature is genuine (Tier 1 passes) but the key is not in the keyring
	// we pass, so Tier 2 - and therefore Trusted() - must be false.
	v, err := VerifyReport(readSample(t), []Issuer{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !v.Tier1Signature {
		t.Errorf("Tier1Signature = false, want true (signature is genuine)")
	}
	if v.Tier2Issuer {
		t.Errorf("Tier2Issuer = true with empty keyring, want false")
	}
	if v.Trusted() {
		t.Errorf("Trusted() = true with unknown issuer, want false")
	}
}

func TestVerifyReportMalformed(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"not json", `not json at all`},
		{"not an object", `[1,2,3]`},
		{"no signature block", `{"schema":"kolm-audit-report-1"}`},
		{"wrong schema", `{"schema":"something-else","signature_ed25519":{}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, err := VerifyReport([]byte(c.in), DefaultKeyring())
			if err == nil {
				t.Errorf("expected error for %q, got verdict %+v", c.in, v)
			}
			if v.Trusted() {
				t.Errorf("zero-value verdict reports Trusted()=true")
			}
		})
	}
}

func TestKeyFingerprintFromPEM(t *testing.T) {
	got, err := KeyFingerprintFromPEM(demoPEM)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != demoFingerprint {
		t.Errorf("KeyFingerprintFromPEM = %q, want %q", got, demoFingerprint)
	}
}

// Example_offlineVerify shows the headline use case: a buyer verifies a signed
// kolm report with no network, no account, no secret.
func Example_offlineVerify() {
	data, err := os.ReadFile("testdata/sample-report.json")
	if err != nil {
		fmt.Println("read error:", err)
		return
	}
	v, err := VerifyReport(data, DefaultKeyring())
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Printf("tier1=%v tier2=%v trusted=%v\n", v.Tier1Signature, v.Tier2Issuer, v.Trusted())
	fmt.Println("fingerprint:", v.KeyFingerprint)
	fmt.Println("issuer:", v.IssuerKID, v.IssuerStatus)
	// Output:
	// tier1=true tier2=true trusted=true
	// fingerprint: 410302c93becdcc3a8091ef0c33c24ed
	// issuer: kolm-demo-2026 demo
}
