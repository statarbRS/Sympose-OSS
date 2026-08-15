# Live connector adapter assumptions

This directory is the provider-network boundary. It does not alter the existing Connector Hub
UI, storage, or local export contracts.

- Airtable uses the fixed `https://api.airtable.com/v0/{base}/{table}` Web API host. Base and table
  values are encoded as path segments. Connection validation lists one record; writes use the
  documented `PATCH` `performUpsert` form and the configured email field as the merge key. The
  adapter caps a batch at 10 records, matching the documented Web API batch limit. Inbound reads
  request only the configured canonical field allowlist, cap pages at 100, validate opaque offsets,
  and use Airtable's record `createdTime` as the available source-version evidence. Airtable does
  not expose a mutation version for ordinary records unless the base defines a last-modified field.
- HubSpot uses the fixed `https://api.hubapi.com/crm/v3/objects/contacts` endpoints. Contact
  identity is always the `email` unique property, and writes use the documented batch upsert
  route. Canonical names map to `firstname`/`lastname`, organization to `company`, and title to
  `jobtitle`. Inbound reads request only those five properties, validate numeric `after` cursors,
  and use the object `updatedAt` timestamp as source-version evidence.
- Salesforce uses the versioned REST query and sObject endpoints. An instance origin must be an
  HTTPS My Domain, sandbox My Domain, or standard `na`/`eu`/`ap`/`cs` instance hostname with no
  credentials, port, path, query, or fragment. The API version accepts `vN.0` or `N.0` and is
  normalized to `vN.0`. Canonical organization maps to Contact `Department`; title maps to
  `Title`. Inbound reads use an allowlisted SOQL projection and Contact-ID keyset pagination with
  `limit + 1` (at most 101 records). This avoids following provider-supplied continuation URLs;
  cursors contain only strictly validated Salesforce IDs. `LastModifiedDate` is the source version.
- Salesforce upsert is deliberately query-then-create/update by escaped email. ID-based `PATCH`
  updates may be retried; `POST` creates are never retried because a transport or 5xx response can
  leave their outcome ambiguous. Airtable and HubSpot writes use provider-supported identity
  upsert semantics and may be retried for 429/5xx responses.
- All providers use bounded response reads, an abort timeout, fixed redacted failure messages,
  bounded 429/5xx retries, and injectable fetch/clock/sleeper dependencies. Retry-After values are
  honored and capped at 60 seconds.
- Inbound records remain provider-neutral external contacts with nullable business fields. Each
  record carries a provider-qualified external identity, normalized source version, observation
  time, and the allowlisted provider field names used as evidence. Duplicate provider record
  identities fail the page; duplicate emails remain representable because providers may allow them.

Official references consulted:

- Airtable Web API support: <https://support.airtable.com/getting-started-with-airtables-web-api>
  and <https://support.airtable.com/managing-api-call-limits-in-airtable>.
- HubSpot CRM v3 Contacts guide: <https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide>
  and batch upsert reference: <https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/batch/upsert-contacts>.
- Salesforce REST API overview and resources: <https://developer.salesforce.com/blogs/2024/04/accessing-object-data-with-salesforce-platform-apis>
  and <https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_composite_post.htm>.
