# Enterprise SSO setup (SAML 2.0 + SCIM 2.0)

kolm supports enterprise Single Sign-On over **SAML 2.0** (login) and automated
user lifecycle over **SCIM 2.0** (provisioning / deprovisioning). Both are
available on the **Business** and **Enterprise** plans.

This guide gives you the exact kolm endpoints and the step-by-step setup for
**Okta** and **Microsoft Entra ID (Azure AD)**. Replace `app.kolm.ai` below with
your kolm host if you run a dedicated instance.

---

## 0. What you need from kolm

| Thing | Value |
| --- | --- |
| SP entity ID (Audience) | `https://app.kolm.ai/saml/sp` |
| ACS URL (Assertion Consumer Service) | `https://app.kolm.ai/v1/account/saml/acs` |
| SP metadata URL | `https://app.kolm.ai/v1/account/saml/metadata` |
| Single Logout URL | `https://app.kolm.ai/v1/account/saml/slo` |
| NameID format | `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress` |
| SCIM 2.0 base URL | `https://app.kolm.ai/v1/scim/v2/` |
| SCIM auth | HTTP header `Authorization: Bearer <scim_token>` |

The SP metadata document at `/v1/account/saml/metadata` is public — point your IdP
at it to auto-fill the ACS URL, SP entity ID and SLO URL. It advertises
`WantAssertionsSigned="true"`: **kolm requires the SAML assertion to be signed.**

---

## 1. Tell kolm about your IdP

All admin calls are authenticated with your kolm tenant **API key**
(`Authorization: Bearer ks_...`). The account owner / an admin runs these.

### Option A — paste the IdP signing certificate (recommended, no metadata file)

```bash
curl -X POST https://app.kolm.ai/v1/account/sso/configure \
  -H "Authorization: Bearer $KOLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "okta",
    "idp_entity_id": "http://www.okta.com/exk1fxxxxxxxx",
    "idp_cert_pem": "-----BEGIN CERTIFICATE-----\nMIID...==\n-----END CERTIFICATE-----",
    "saml_audience": "https://app.kolm.ai/saml/sp",
    "jit_provisioning": true,
    "domains": ["yourcompany.com"]
  }'
```

Field reference:

| Field | Required | Notes |
| --- | --- | --- |
| `provider` | yes | `okta`, `azure-ad`, `onelogin`, `jumpcloud`, `google-workspace`, or `saml-generic`. |
| `idp_entity_id` | yes (manual) | Your IdP's **Issuer / entity ID**. kolm routes an incoming assertion to your tenant by matching its `<Issuer>` to this value, so it must be exact. |
| `idp_cert_pem` | yes (manual) | The IdP's **signing certificate**. Full PEM or the bare base64 body from `<X509Certificate>`. Validated on save (a malformed cert returns HTTP 400). Stored to verify assertions; **never returned by the API**. |
| `saml_audience` | optional | Expected `<Audience>`. Defaults to `https://<host>/saml/sp`. Set it if your IdP sends a different Audience. |
| `jit_provisioning` | optional (default `true`) | If `true`, a user who passes SAML but has no kolm seat yet is linked on first login. Set `false` to require SCIM provisioning first. |
| `domains` | optional | Email domains you own (informational / allow-list). |

> You can also configure via `metadata_url` (`https://...`) or `metadata_xml`
> if you prefer to hand kolm the IdP metadata document instead of the raw cert.

Check status (secrets are never echoed — only presence booleans + a cert
fingerprint):

```bash
curl https://app.kolm.ai/v1/account/sso/status -H "Authorization: Bearer $KOLM_API_KEY"
# { "entitled": true, "configured": true,
#   "config": { "idp_cert_configured": true, "idp_cert_sha256": "sha256:...",
#               "saml_audience": "https://app.kolm.ai/saml/sp",
#               "scim_token_set": false, "secret_values_included": false } }
```

### Mint the SCIM bearer token

Generate the token your IdP will use for SCIM. It is shown **once**; kolm stores
only its hash and never logs it. Re-running rotates it (and invalidates the old
one).

```bash
curl -X POST https://app.kolm.ai/v1/account/sso/scim-token \
  -H "Authorization: Bearer $KOLM_API_KEY"
# { "ok": true,
#   "scim_token": "scim_3f8a...<copy now>",
#   "token_type": "Bearer",
#   "scim_base_url": "https://app.kolm.ai/v1/scim/v2/" }
```

---

## 2. Okta

### 2a. SAML app

1. **Admin console → Applications → Create App Integration → SAML 2.0.**
2. **Single sign-on URL (ACS):** `https://app.kolm.ai/v1/account/saml/acs`
   — also tick *Use this for Recipient URL and Destination URL*.
3. **Audience URI (SP Entity ID):** `https://app.kolm.ai/saml/sp`
4. **Name ID format:** `EmailAddress`. **Application username:** `Email`.
5. **Attribute Statements** (used to populate the kolm profile):
   - `email` → `user.email`
   - `firstName` → `user.firstName`
   - `lastName` → `user.lastName`
6. Finish, then open **Sign On → View SAML setup instructions** (or the app's
   metadata). Copy the **Identity Provider Issuer** and the **X.509 Certificate**.
7. Send those to kolm with the `/v1/account/sso/configure` call in step 1
   (`idp_entity_id` = Issuer, `idp_cert_pem` = X.509 Certificate).

Okta signs the **assertion** by default — keep that on (kolm requires signed
assertions). Assign users/groups to the app so they can log in.

### 2b. SCIM provisioning

1. In the same Okta app, **General → Provisioning → enable SCIM**.
2. **Provisioning → Integration:**
   - **SCIM connector base URL:** `https://app.kolm.ai/v1/scim/v2/`
   - **Unique identifier field for users:** `userName`
   - **Supported provisioning actions:** Push New Users, Push Profile Updates,
     Push Groups, Deactivate Users.
   - **Authentication Mode:** *HTTP Header*, header
     `Authorization: Bearer <scim_token>` (the token from step 1).
3. **Test Connector Configuration**, then **To App → enable** Create /
   Update / Deactivate Users.

Deactivating or unassigning a user in Okta sends `PATCH .../Users/:id` with
`active:false`; kolm releases that seat and revokes member-scoped API keys.

---

## 3. Microsoft Entra ID (Azure AD)

### 3a. SAML SSO

1. **Entra admin center → Enterprise applications → New application → Create your
   own application →** *Integrate any other application (non-gallery)*.
2. Open **Single sign-on → SAML.**
3. **Basic SAML Configuration:**
   - **Identifier (Entity ID):** `https://app.kolm.ai/saml/sp`
   - **Reply URL (ACS):** `https://app.kolm.ai/v1/account/saml/acs`
4. **Attributes & Claims:** ensure the **Unique User Identifier (Name ID)** is
   `user.mail` with format **Email address**. Add claims `email` (`user.mail`),
   `firstName` (`user.givenname`), `lastName` (`user.surname`).
5. **SAML Certificates:** download **Certificate (Base64)**. Note the **Azure AD
   Identifier** under *Set up <app>* — that is your `idp_entity_id`
   (e.g. `https://sts.windows.net/<tenant-guid>/`).
6. Send the certificate + identifier to kolm with `/v1/account/sso/configure`.

Entra signs the assertion by default. Assign users/groups under **Users and
groups**.

### 3b. SCIM provisioning

1. In the same enterprise app, **Provisioning → Get started → Mode: Automatic.**
2. **Admin Credentials:**
   - **Tenant URL:** `https://app.kolm.ai/v1/scim/v2/`
   - **Secret Token:** the `scim_token` from step 1.
3. **Test Connection**, **Save**, then start provisioning. Entra sends
   `userName` as an email; deactivation arrives as `PATCH .../Users/:id` with
   `active:false` (Entra) or a soft-delete, both of which deprovision the seat.

---

## 4. How a login works (so you can debug)

1. The user authenticates at the IdP; the IdP POSTs a signed `SAMLResponse` to
   `https://app.kolm.ai/v1/account/saml/acs` (the browser carries no kolm key).
2. kolm reads the **`<Issuer>`** to find which tenant configured this IdP, then
   verifies the assertion's XML signature against that tenant's pinned
   `idp_cert_pem`. **No claim is trusted until the signature verifies.**
3. kolm validates the time window (`NotBefore`/`NotOnOrAfter` with a 5-minute
   clock-skew tolerance), the `<Audience>`, and the `Recipient`, and rejects a
   replayed assertion ID.
4. kolm links/finds the member, mints a per-login session credential (this does
   **not** rotate your tenant's API key or sign other members out), sets the
   `kolm_session` cookie, and redirects the browser to `/dashboard`.

### Common rejections

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 404 | `sso_tenant_not_resolved` | The assertion `<Issuer>` matches no tenant's `idp_entity_id`. Fix `idp_entity_id`. |
| 402 | `enterprise_only` | The tenant is not on a Business/Enterprise plan. |
| 501 | `sso_not_configured` | No enabled SSO config for the tenant. |
| 503 | `saml_not_configured` | No `idp_cert_pem` stored. Re-run configure with the cert. |
| 401 | `signature_verification_failed` | Wrong/missing signature, tampered assertion, or wrong cert. |
| 401 | `assertion_expired` / `audience_mismatch` / `recipient_mismatch` | Time window / Audience / Recipient did not match. |
| 401 | `assertion_replayed` | This assertion ID was already consumed (single-use). |

---

## 5. SCIM endpoint reference

Base URL: `https://app.kolm.ai/v1/scim/v2/` · Auth: `Authorization: Bearer <scim_token>`
(the per-tenant SCIM token; your tenant API key also works). Every resource is
tenant-fenced — a token only ever sees its own tenant's users and groups.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ServiceProviderConfig` | Capabilities (public). |
| GET | `/Users?filter=userName eq "a@b.com"` | List / filter users. |
| POST | `/Users` | Create a user (`userName` must be an email). |
| GET | `/Users/:id` | Read a user. |
| PUT | `/Users/:id` | Replace a user (`active:false` deprovisions). |
| PATCH | `/Users/:id` | Patch a user (`active:false` deprovisions). |
| DELETE | `/Users/:id` | Hard deprovision (release seat + revoke keys). |
| GET / POST | `/Groups` | List / create groups. A group named after a kolm role (`owner`/`admin`/`member`/`billing`) grants that role to its members. |
| GET / PUT / PATCH / DELETE | `/Groups/:id` | Read / replace / patch / delete a group. |

Missing or invalid bearer token returns HTTP **401** with a SCIM Error envelope
(`urn:ietf:params:scim:api:messages:2.0:Error`).

---

## 6. Security notes

- **Signed assertions required.** The SP metadata advertises
  `WantAssertionsSigned="true"`; an unsigned or wrongly-signed assertion is
  rejected with `signature_verification_failed`.
- **Replay protection.** Each Assertion ID is consumed at most once per tenant;
  the cache is durable across restarts.
- **Per-tenant isolation.** Tenant routing is by signed `<Issuer>`, and every
  SCIM/session write is fenced to the resolved tenant.
- **Secrets are write-only.** The SCIM token is stored hashed and shown once; the
  IdP signing certificate is public key material but is never echoed back by the
  API. Neither is ever written to logs or the audit trail.
- **Non-destructive sessions.** An SSO login mints a per-login session
  credential; it never rotates your tenant's primary API key, so existing
  members and server-to-server integrations stay signed in.

### XML signature processing — known limitation

The assertion signature is verified with `node:crypto` using anchored parsing
and a whitespace-normalizing canonicalization that matches the serialization
mainstream IdPs (Okta, Entra ID, OneLogin, Google) emit. It is **not** a full
Exclusive XML Canonicalization (`xml-exc-c14n`) implementation. Signature
wrapping (XSW) is mitigated by reading the NameID/attributes **only** from the
element the signature's `Reference` covers. For a deployment behind an
adversarial or non-conformant IdP, swap `_verifyXmlSignature()` in
`src/saml-acs.js` for a vetted `xml-crypto`-based verifier. This is documented in
the header of `src/saml-acs.js`.
