package kolm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// SDKVersion is the version of this Go SDK, sent in the User-Agent header.
const SDKVersion = "0.1.0"

// DefaultBaseURL is the production kolm.ai API origin.
const DefaultBaseURL = "https://kolm.ai"

// DefaultTimeout is the per-request timeout of a client built by [NewClient].
const DefaultTimeout = 30 * time.Second

// maxResponseBytes caps how much of a response body the client will read, so a
// hostile or buggy server cannot exhaust memory. A signed report envelope is the
// largest expected payload and is comfortably under this.
const maxResponseBytes = 32 << 20 // 32 MiB

// Client is a thin HTTP client for the kolm.ai Agent Security-Review API.
//
// It is safe for concurrent use by multiple goroutines. The offline verifier
// ([VerifyReport]) needs no client at all; this type is a convenience for
// running scans, listing reports, and starting checkouts. Every method takes a
// context.Context so calls are cancelable and deadline-aware.
type Client struct {
	// BaseURL is the API origin, without a trailing slash.
	BaseURL string
	// APIKey is sent as "Authorization: Bearer <key>" when non-empty. Public
	// endpoints (issuer-key, report/verify) work without one.
	APIKey string
	// UserAgent is sent on every request.
	UserAgent string
	// HTTPClient is the underlying client; nil uses http.DefaultClient.
	HTTPClient *http.Client
}

// NewClient builds a client for baseURL with the given API key. An empty baseURL
// defaults to [DefaultBaseURL]. A trailing slash on baseURL is trimmed.
func NewClient(baseURL, apiKey string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		APIKey:     apiKey,
		UserAgent:  "kolm-go/" + SDKVersion,
		HTTPClient: &http.Client{Timeout: DefaultTimeout},
	}
}

// NewClientFromEnv builds a client from KOLM_BASE_URL (default [DefaultBaseURL])
// and KOLM_API_KEY. A client without an API key is valid and useful for the
// public endpoints.
func NewClientFromEnv() *Client {
	return NewClient(os.Getenv("KOLM_BASE_URL"), os.Getenv("KOLM_API_KEY"))
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

// APIError is returned for a non-2xx HTTP response. It carries the parsed kolm
// error envelope ({ "error", "detail" }) plus the raw status and body.
type APIError struct {
	StatusCode int
	Code       string
	Detail     string
	Missing    []string
	Body       string
}

func (e *APIError) Error() string {
	switch {
	case e.Code != "" && e.Detail != "":
		return fmt.Sprintf("kolm: HTTP %d %s: %s", e.StatusCode, e.Code, e.Detail)
	case e.Code != "":
		return fmt.Sprintf("kolm: HTTP %d %s", e.StatusCode, e.Code)
	default:
		return fmt.Sprintf("kolm: HTTP %d", e.StatusCode)
	}
}

// do performs an HTTP request and decodes a 2xx JSON body into out (out may be
// nil). A non-2xx response becomes an [*APIError]; a transport failure becomes a
// wrapped error.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("kolm: encode request body: %w", err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)
	if err != nil {
		return fmt.Errorf("kolm: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("kolm: request to %s failed: %w", path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("kolm: read response from %s: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return parseAPIError(resp.StatusCode, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("kolm: decode %s response: %w", path, err)
		}
	}
	return nil
}

func parseAPIError(status int, body []byte) *APIError {
	e := &APIError{StatusCode: status, Body: string(body)}
	var p struct {
		Error   string   `json:"error"`
		Detail  string   `json:"detail"`
		Missing []string `json:"missing"`
	}
	_ = json.Unmarshal(body, &p)
	e.Code = p.Error
	e.Detail = p.Detail
	e.Missing = p.Missing
	return e
}

// ---------------------------------------------------------------------------
// Request / response types.
// ---------------------------------------------------------------------------

// ScanRequest is the body of POST /v1/audit/scan.
//
// Logs accepts either raw JSONL text (a string) or a slice of record objects;
// both are forwarded under the "logs" key as the server expects.
type ScanRequest struct {
	Logs          any    `json:"logs"`
	Subject       string `json:"subject,omitempty"`
	Source        string `json:"source,omitempty"`
	RetentionDays *int   `json:"retention_days,omitempty"`
	// Sign defaults to true server-side; set to a *bool of false to skip signing.
	Sign *bool `json:"sign,omitempty"`
	// Persist defaults to true server-side; set to a *bool of false for a
	// stateless scan that is not stored.
	Persist *bool `json:"persist,omitempty"`
}

// ScanResponse is the result of POST /v1/audit/scan. Report is the bare signed
// envelope and can be handed straight to [VerifyReport].
type ScanResponse struct {
	OK             bool            `json:"ok"`
	ID             string          `json:"id"`
	ReportID       string          `json:"report_id"`
	Signed         bool            `json:"signed"`
	KeyFingerprint string          `json:"key_fingerprint"`
	Summary        json.RawMessage `json:"summary"`
	Ingest         json.RawMessage `json:"ingest"`
	Report         json.RawMessage `json:"report"`
	VerifyURL      string          `json:"verify_url"`
}

// ReportSummary is one row of GET /v1/audit/reports.
type ReportSummary struct {
	ID            string   `json:"id"`
	ReportID      string   `json:"report_id"`
	Subject       string   `json:"subject"`
	ReadinessPct  *float64 `json:"readiness_pct"`
	BlockingCount *int     `json:"blocking_count"`
	Tier          string   `json:"tier"`
	Paid          bool     `json:"paid"`
	PublicSlug    string   `json:"public_slug"`
	TrustURL      string   `json:"trust_url"`
	Source        string   `json:"source"`
	CreatedAt     string   `json:"created_at"`
}

// ReportsResponse is the result of GET /v1/audit/reports.
type ReportsResponse struct {
	OK      bool            `json:"ok"`
	Reports []ReportSummary `json:"reports"`
	Billing json.RawMessage `json:"billing"`
}

// CheckoutResponse is the result of the report and continuous checkout calls.
// URL is the hosted checkout URL to redirect the buyer to; AlreadyPaid is true
// when the report was already purchased.
type CheckoutResponse struct {
	OK          bool   `json:"ok"`
	URL         string `json:"url"`
	Source      string `json:"source"`
	AlreadyPaid bool   `json:"already_paid"`
	TrustURL    string `json:"trust_url"`
}

// IssuerKeyResponse is the result of GET /v1/audit/issuer-key: the live Ed25519
// PUBLIC key this server signs evidence with, for pinning.
type IssuerKeyResponse struct {
	OK             bool   `json:"ok"`
	Alg            string `json:"alg"`
	Spec           string `json:"spec"`
	PublicKey      string `json:"public_key"`
	KeyFingerprint string `json:"key_fingerprint"`
	Source         string `json:"source"`
}

// RemoteVerifyResponse is the result of POST /v1/audit/report/verify. Trusted is
// the server's combined tier-1-and-tier-2 verdict; Verify and Issuer carry the
// detailed sub-results. Prefer offline [VerifyReport] — this endpoint is a
// convenience that requires trusting the server.
type RemoteVerifyResponse struct {
	OK      bool            `json:"ok"`
	Trusted bool            `json:"trusted"`
	Verify  json.RawMessage `json:"verify"`
	Issuer  json.RawMessage `json:"issuer"`
}

// ---------------------------------------------------------------------------
// Endpoints.
// ---------------------------------------------------------------------------

// Scan runs a one-shot audit (POST /v1/audit/scan): logs in, a signed report out
// in a single call. Requires an API key.
func (c *Client) Scan(ctx context.Context, req ScanRequest) (*ScanResponse, error) {
	var out ScanResponse
	if err := c.do(ctx, http.MethodPost, "/v1/audit/scan", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Reports lists the tenant's reports (GET /v1/audit/reports). Requires an API key.
func (c *Client) Reports(ctx context.Context) (*ReportsResponse, error) {
	var out ReportsResponse
	if err := c.do(ctx, http.MethodGet, "/v1/audit/reports", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ReportCheckout starts the one-time purchase of the Signed Readiness Report for
// a specific audit (POST /v1/audit/report/checkout). Requires an API key.
func (c *Client) ReportCheckout(ctx context.Context, auditID string) (*CheckoutResponse, error) {
	body := map[string]string{"audit_id": auditID}
	var out CheckoutResponse
	if err := c.do(ctx, http.MethodPost, "/v1/audit/report/checkout", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ContinuousCheckout subscribes to Continuous re-attestation
// (POST /v1/audit/continuous/checkout). plan is "starter" or "growth". Requires
// an API key.
func (c *Client) ContinuousCheckout(ctx context.Context, plan string) (*CheckoutResponse, error) {
	body := map[string]string{"plan": plan}
	var out CheckoutResponse
	if err := c.do(ctx, http.MethodPost, "/v1/audit/continuous/checkout", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// IssuerKey fetches the live signing public key (GET /v1/audit/issuer-key). This
// is a PUBLIC endpoint — no API key required. Use it to pin a report against the
// authoritative key or to build a fresh keyring after a key rotation.
func (c *Client) IssuerKey(ctx context.Context) (*IssuerKeyResponse, error) {
	var out IssuerKeyResponse
	if err := c.do(ctx, http.MethodGet, "/v1/audit/issuer-key", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// VerifyRemote asks the server to verify a signed report
// (POST /v1/audit/report/verify, a PUBLIC endpoint). Offline [VerifyReport] is
// preferred and needs no trust in the server; this is offered for parity with
// the /verify web page. report is the raw signed envelope JSON.
func (c *Client) VerifyRemote(ctx context.Context, report json.RawMessage) (*RemoteVerifyResponse, error) {
	body := map[string]json.RawMessage{"report": report}
	var out RemoteVerifyResponse
	if err := c.do(ctx, http.MethodPost, "/v1/audit/report/verify", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
