// Command offline-verify verifies a signed kolm Agent Security-Review report
// entirely offline — no network, no kolm account, no shared secret.
//
// Usage:
//
//	go run ./examples/offline-verify path/to/report.json
//
// It exits 0 only when the report is TRUSTED (signed by a recognized kolm issuer
// and untampered), and non-zero otherwise, so it drops straight into CI.
package main

import (
	"fmt"
	"os"

	kolm "github.com/kolm-ai/kolm-go"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: offline-verify <report.json>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(1)
	}

	v, err := kolm.VerifyReport(data, kolm.DefaultKeyring())
	if err != nil {
		// A hard error means the input is not a verifiable kolm report at all.
		fmt.Fprintln(os.Stderr, "cannot verify:", err)
		os.Exit(1)
	}

	for _, c := range v.Checks {
		mark := "FAIL"
		if c.OK {
			mark = " ok "
		}
		fmt.Printf("  [%s] %-26s %s\n", mark, c.Name, c.Detail)
	}
	fmt.Println()
	fmt.Printf("tier 1 (signature): %v\n", v.Tier1Signature)
	fmt.Printf("tier 2 (issuer):    %v  %s %s\n", v.Tier2Issuer, v.IssuerKID, v.IssuerStatus)
	fmt.Printf("key fingerprint:    %s\n", v.KeyFingerprint)
	fmt.Printf("TRUSTED:            %v  (%s)\n", v.Trusted(), v.Reason)

	if !v.Trusted() {
		os.Exit(1)
	}
}
