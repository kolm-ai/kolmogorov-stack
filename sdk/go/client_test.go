package kolm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewClientTrimsTrailingSlash(t *testing.T) {
	c := NewClient("https://kolm.ai/", "")
	if c.BaseURL != "https://kolm.ai" {
		t.Errorf("BaseURL = %q, want https://kolm.ai", c.BaseURL)
	}
}

func TestNewClientFromEnvDefaultsBase(t *testing.T) {
	t.Setenv("KOLM_BASE_URL", "")
	t.Setenv("KOLM_API_KEY", "")
	c := NewClientFromEnv()
	if c.BaseURL != DefaultBaseURL {
		t.Errorf("BaseURL = %q, want %q", c.BaseURL, DefaultBaseURL)
	}
}

func TestClientScan(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/audit/scan" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer ks_test" {
			t.Errorf("Authorization = %q, want Bearer ks_test", got)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q", got)
		}
		var body ScanRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if body.Subject != "Fleet" {
			t.Errorf("subject = %q, want Fleet", body.Subject)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"id":"audses_1","report_id":"asrr_1","signed":true,`+
			`"key_fingerprint":"fa56","report":{"schema":"kolm-audit-report-1"},`+
			`"verify_url":"https://kolm.ai/verify"}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ks_test")
	resp, err := c.Scan(context.Background(), ScanRequest{Logs: "{}", Subject: "Fleet"})
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if !resp.OK || resp.ReportID != "asrr_1" || !resp.Signed {
		t.Errorf("resp = %+v", resp)
	}
	// Report is handed back as raw JSON, ready for offline VerifyReport.
	if len(resp.Report) == 0 {
		t.Error("resp.Report is empty")
	}
}

func TestClientReports(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/audit/reports" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"reports":[{"id":"a","report_id":"asrr_1",`+
			`"subject":"Fleet","readiness_pct":50,"blocking_count":2,"tier":"report",`+
			`"paid":true,"created_at":"2026-06-08"}],"billing":{"ready":true}}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ks_test")
	resp, err := c.Reports(context.Background())
	if err != nil {
		t.Fatalf("Reports: %v", err)
	}
	if len(resp.Reports) != 1 {
		t.Fatalf("len(reports) = %d, want 1", len(resp.Reports))
	}
	r0 := resp.Reports[0]
	if r0.ReportID != "asrr_1" || !r0.Paid || r0.Tier != "report" {
		t.Errorf("report[0] = %+v", r0)
	}
	if r0.ReadinessPct == nil || *r0.ReadinessPct != 50 {
		t.Errorf("ReadinessPct = %v, want 50", r0.ReadinessPct)
	}
	if r0.BlockingCount == nil || *r0.BlockingCount != 2 {
		t.Errorf("BlockingCount = %v, want 2", r0.BlockingCount)
	}
}

func TestClientReportCheckout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit/report/checkout" {
			t.Errorf("path = %q", r.URL.Path)
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["audit_id"] != "audses_1" {
			t.Errorf("audit_id = %q", body["audit_id"])
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"url":"https://checkout.example/x","source":"stripe_checkout_api"}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ks_test")
	resp, err := c.ReportCheckout(context.Background(), "audses_1")
	if err != nil {
		t.Fatalf("ReportCheckout: %v", err)
	}
	if resp.URL != "https://checkout.example/x" {
		t.Errorf("URL = %q", resp.URL)
	}
}

func TestClientIssuerKeyIsPublic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audit/issuer-key" {
			t.Errorf("path = %q", r.URL.Path)
		}
		// No API key set -> no Authorization header should be sent.
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("public endpoint received Authorization header %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"alg":"ed25519","spec":"kolm-ed25519-v1",`+
			`"public_key":"PEM","key_fingerprint":"fa56","source":"env"}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "") // no API key
	resp, err := c.IssuerKey(context.Background())
	if err != nil {
		t.Fatalf("IssuerKey: %v", err)
	}
	if resp.Alg != "ed25519" || resp.KeyFingerprint != "fa56" {
		t.Errorf("resp = %+v", resp)
	}
}

func TestClientAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		io.WriteString(w, `{"ok":false,"error":"report_not_ready","detail":"scan first"}`)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ks_test")
	_, err := c.ReportCheckout(context.Background(), "audses_x")
	if err == nil {
		t.Fatal("expected an error for HTTP 402")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type = %T, want *APIError", err)
	}
	if apiErr.StatusCode != http.StatusPaymentRequired {
		t.Errorf("StatusCode = %d, want 402", apiErr.StatusCode)
	}
	if apiErr.Code != "report_not_ready" || apiErr.Detail != "scan first" {
		t.Errorf("apiErr = %+v", apiErr)
	}
}

func TestClientContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already canceled
	c := NewClient(srv.URL, "ks_test")
	if _, err := c.Reports(ctx); err == nil {
		t.Error("expected error from canceled context")
	}
}
