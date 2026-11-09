# Feature Specification: Bark Push Server on Supabase

**Feature Branch**: `001-bark-server-supabase`

**Created**: 2026-11-09

**Status**: Draft

**Input**: User description: "create a supabase project, implement Finb/bark-server in supabase"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Register an iPhone and receive a notification (Priority: P1)

A person installs the Bark app on their iPhone, points it at their own server address, and the app registers the phone with the server. The server replies with a device key and a ready-to-use test command. The person runs that command (or taps the test button in the app) and a notification appears on the phone.

**Why this priority**: Without device registration and a working notification delivery there is no product. Everything else (rich parameters, archiving, batch delivery) is additive on top of this journey.

**Independent Test**: With a fresh deployment, register one device, send one notification with a title and body, and confirm it appears on the physical phone. This alone delivers the core value of "my own push server".

**Acceptance Scenarios**:

1. **Given** a deployment with valid push credentials, **When** the app registers a device for the first time, **Then** the server issues a new device key and returns it to the app in a form the app accepts without modification.
2. **Given** a registered device with key `K`, **When** a notification request is sent for `K` with a title and a body, **Then** the phone displays that title and body as a notification.
3. **Given** a device already registered under key `K`, **When** the app re-registers and supplies the same key with a refreshed device token, **Then** the key is preserved, the stored token is replaced, and delivery continues to work with no user intervention.
4. **Given** a legacy client that uses the path-based form (`/{key}/{title}/{body}`), **When** that request is sent, **Then** the notification is delivered exactly as if it had been sent with the current JSON request form.

---

### User Story 2 - Existing tools send notifications without changes (Priority: P2)

People already use self-hosted Bark with monitoring tools, SMS-forwarding apps, scripts, and iOS Shortcuts. They point those tools at the new server address and expect them to keep working, including tools that only support the legacy path-based and form-encoded request styles.

**Why this priority**: The value of a Bark-compatible server is largely that the existing ecosystem works. A server that only supports one modern request shape would force users to rewrite their automations.

**Independent Test**: Take the documented example requests for at least three distinct client styles (path-based, form-encoded body, JSON body) and confirm each produces an identical notification on the same device.

**Acceptance Scenarios**:

1. **Given** a valid key, **When** a client sends a form-encoded request to the key path with fields such as title, body, and group, **Then** the notification carries those fields.
2. **Given** a valid key, **When** a client sends a JSON request that names the key inside the request payload rather than in the path, **Then** the notification is delivered normally.
3. **Given** two registered devices, **When** a single request addresses both of them, **Then** both phones receive the notification and the response reports per-device success or failure.
4. **Given** a key that does not exist, **When** a notification is requested, **Then** no push is attempted and the caller receives a clear failure result naming the problem.

---

### User Story 3 - Rich notification behavior is preserved (Priority: P3)

People who rely on grouped notifications, custom sounds, badges, icons, tap-through links, critical/time-sensitive alerts, and auto-copy text keep getting the same behavior they had on their previous server.

**Why this priority**: These parameters are what make Bark useful beyond plain text alerts, but the product is still viable with title and body only.

**Independent Test**: Send one notification per supported parameter group and confirm each behaves as documented (grouped stacking, custom sound, badge count, tappable link, critical alert requiring the entitlement, text placed on the clipboard).

**Acceptance Scenarios**:

1. **Given** a registered device, **When** a notification sets a group name, **Then** the phone stacks it with other notifications carrying the same group.
2. **Given** a notification that sets a badge count, **When** it is delivered, **Then** the app icon shows that count.
3. **Given** a notification marked as critical with a volume, **When** it is delivered, **Then** it plays at the requested volume and bypasses silent mode where the app is entitled to do so.
4. **Given** a notification with a tap-through link, **When** the user taps it, **Then** the link opens; **Given** a notification marked to do nothing on tap, **When** tapped, **Then** no navigation happens.
5. **Given** a notification that marks content for auto-copy, **When** it is delivered, **Then** the designated text is placed on the clipboard.

---

### User Story 4 - Operator deploys, monitors, and troubleshoots (Priority: P3)

The person operating the server verifies that the service is alive, confirms which build and configuration is running, and can find out why a notification did not arrive.

**Why this priority**: Self-hosted software is only trustworthy if its operator can tell health from failure. It is not required for the first notification to work.

**Independent Test**: From a clean deployment, call the health and info capabilities, disable the push credentials, and confirm the failure is clearly reported and diagnosable.

**Acceptance Scenarios**:

1. **Given** a running deployment, **When** the operator checks liveness, **Then** a healthy response is returned without requiring authentication.
2. **Given** a running deployment, **When** the operator requests server information, **Then** the response reports the running version and non-secret configuration.
3. **Given** missing or invalid push credentials, **When** the operator triggers a delivery, **Then** the response and the logs identify the credential problem rather than reporting a generic failure.
4. **Given** a device whose push token has been invalidated by the platform, **When** a delivery is attempted, **Then** the failure is recorded and the registration is flagged as no longer reachable.

---

### User Story 5 - End-to-end encrypted and archived notifications (Priority: P4)

A person who does not want notification content readable by the server, or who wants the app to keep a history they can review later, keeps that behavior when moving to the new server.

**Why this priority**: These are opt-in privacy and convenience features; the product works without them, and they can be added once core delivery is stable.

**Independent Test**: Send an encrypted payload and confirm the server delivers it unchanged; send a notification marked for archiving and confirm it is retained for the requested lifetime and removed afterwards.

**Acceptance Scenarios**:

1. **Given** a client that encrypts content, **When** an encrypted payload is delivered, **Then** the payload reaches the device unmodified and the server never stores or logs the plaintext.
2. **Given** a notification marked for archiving with a lifetime, **When** the lifetime elapses, **Then** the stored item is removed automatically and the device is not offered it again.

---

### Edge Cases

- A registration arrives with no device token, or with a token longer than the platform allows: the request is rejected with a specific reason and no registration is stored.
- A registration declares an unknown device kind (for example something other than a phone or a watch): the request is rejected with a specific reason.
- A device token is refreshed by the operating system while the old and new registrations race: the surviving registration must be consistent and pushes must not fail permanently.
- The same key is used by two devices at once (for example a phone and its paired watch): each registered device kind receives the notification through its own delivery channel.
- A notification body contains slashes, spaces, emoji, or other characters that are meaningful in a URL path: the text is delivered literally rather than truncated or interpreted.
- A title or body exceeds the platform's notification size limit: the caller gets a clear error (or documented truncation) instead of a silent partial delivery.
- Apple's push service rejects a token as invalid, expired, or belonging to a different environment: the delivery is marked failed, the device is flagged, and the caller can distinguish this from a transient error.
- Apple's push service is slow, unavailable, or rate-limiting: the caller receives a retryable failure and no duplicate notifications are produced for one request.
- A request supplies credentials the deployment does not have: the failure names the missing configuration item.
- A burst of requests arrives from one sender or one device: excess traffic is rejected with a clear rate-limit response rather than degrading deliveries for everyone.
- A malformed or oversized request body arrives: it is rejected without being forwarded to Apple's service.

## Requirements *(mandatory)*

### Functional Requirements

**Device registration**

- **FR-001**: System MUST allow a device to register itself by supplying a push token, and MUST issue a device key that clients use to target that device.
- **FR-002**: System MUST accept an optional caller-supplied device key on registration, reusing it for an existing device and preserving it across token refreshes.
- **FR-003**: System MUST support registration in the current JSON request form, in the legacy query-parameter form, and MUST NOT require the client to change the request style it already uses.
- **FR-004**: System MUST let a client confirm whether a given device key is known, returning a success or a "not found" result.
- **FR-005**: System MUST accept a device kind (phone or watch), defaulting to phone for clients that omit it, and MUST reject values it does not support.
- **FR-006**: System MUST record when a device registration was first created and when its token was last updated, so the operator can identify stale registrations.

**Notification delivery**

- **FR-007**: System MUST accept a notification addressed to one device, with a required body and optional title, subtitle, and other supported presentation parameters.
- **FR-008**: System MUST accept the same notification addressed to several device keys in one request and MUST report per-device outcomes.
- **FR-009**: System MUST accept notifications in all documented request shapes: path-based (key only, key with body, key with title and body, key with title, subtitle, and body), form-encoded bodies, and JSON bodies with the key either in the path or in the payload.
- **FR-010**: System MUST support the presentation parameters that clients already depend on: grouping, custom sound, badge count, icon, tap-through link, tap behavior, alert level (including critical and time-sensitive), critical-alert volume, continuous ring, auto-copy, and copy text.
- **FR-011**: System MUST deliver each notification to Apple's push service on behalf of the device's own registration, using the delivery channel and notification topic appropriate to the device kind.
- **FR-012**: System MUST treat an encrypted payload as opaque: forward it unmodified, never attempt to decrypt it, and never log its content.
- **FR-013**: System MUST reject a notification that cannot be delivered as requested (unknown key, empty body, unsupported parameter value, oversized payload) with a non-success result that names the reason, and MUST NOT report success for a delivery that did not reach the push service.
- **FR-014**: System MUST return responses in the single, consistent response shape that existing clients parse (a status code, a human-readable message, an optional data payload, and a timestamp).

**Operation and access control**

- **FR-015**: System MUST expose an unauthenticated liveness check, a readiness check that reflects whether the deployment can actually push, and a server-information endpoint reporting version and non-secret configuration.
- **FR-016**: System MUST support an optional server-wide access credential that, when configured, blocks unauthenticated use of registration and notification endpoints without requiring client configuration changes beyond the credential itself.
- **FR-017**: System MUST enforce that a device key can only target its own registration, and that no request can cause a notification to be delivered to a device the caller did not address.
- **FR-018**: System MUST apply rate limits that protect delivery quality, rejecting excess requests with a clearly identifiable rate-limit response.
- **FR-019**: System MUST keep push credentials out of stored data, API responses, logs, and version control, and MUST allow them to be replaced without a code change.
- **FR-020**: System MUST record, for each attempted delivery, the outcome, the reason for any failure, and the target device — enough for an operator to diagnose a missing notification — without logging message content, device tokens, or device keys in clear text.
- **FR-021**: System MUST flag or remove registrations whose tokens the push service reports as permanently invalid, so future attempts fail fast with an actionable reason.
- **FR-022**: System MUST retry deliveries that fail for transient reasons, without producing duplicate notifications for a single request.
- **FR-023**: System MUST store archived notifications only when the sender asks for archiving, MUST honor the sender's requested lifetime, and MUST delete archived items automatically once that lifetime has passed.

**Scope of compatibility**

- **FR-024**: System MUST be usable by the unmodified Bark app against a server address the user supplies, covering the registration, delivery, and health interactions that app performs.
- **FR-025**: System MUST remain compatible with the published server interface for the covered endpoints, so that existing third-party integrations continue to work without changes.
- **FR-026**: System MUST cover this interface surface and no more: device registration (create, reuse, confirm), single and batch notification delivery in all documented request shapes, the archive flag with its lifetime, liveness/readiness/server-info, and the access-control and rate-limit protections above. Notification history retrieval, the reference server's agent/tool-protocol endpoint, and its file-based and MySQL storage backends are explicitly out of scope.
- **FR-027**: System MUST be deployable to a Supabase project using only capabilities that project offers (managed database, serverless endpoints, secret storage, scheduled work), with no long-running self-managed process required.
- **FR-028**: System MUST allow any device to self-register without prior approval, and MUST let the operator list registrations with their status and last update time and disable a registration so it stops receiving notifications, all without editing application code.
- **FR-029**: System MUST be verified end to end against real devices on a hosted Supabase project, using live Apple push credentials, and MUST keep the same behaviour testable in a local development stack where real delivery is not possible.

### Key Entities *(include if data involved)*

- **Device Registration**: A single delivery target. Holds the device key used by clients, the push token issued by the operating system, the device kind, and creation/last-updated timestamps. Identified by device key; a key is unique across the deployment, and the same key may coexist for two device kinds belonging to one person.
- **Notification Request**: One accepted request from a sender. Holds the target device key or keys, the content and presentation parameters, whether the payload is encrypted, whether it should be archived, and the requested lifetime. May produce several delivery attempts.
- **Delivery Attempt**: The outcome of sending one notification to one device through Apple's push service — timestamp, result, failure reason, and whether retrying is worthwhile.
- **Archived Notification**: A notification intentionally retained for later review by the app, with its creation time, requested lifetime, and owning device. Removed automatically at expiry.
- **Server Information**: The deployment's reported version and non-secret configuration, used by operators and by clients that probe the server.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user goes from installing the app to receiving their first notification on their own server in under 5 minutes, with no manual data entry beyond pasting the server address.
- **SC-002**: At least 95% of accepted notifications are displayed on the device within 5 seconds of being accepted, and none are reported as accepted if they were never handed to the push service.
- **SC-003**: At least 99% of registration attempts succeed on the first try and return a key that the app immediately treats as valid.
- **SC-004**: 100% of the documented request styles exercised by existing integrations (path-based, form-encoded, JSON with key in path, JSON with key in payload) produce identical notifications for the same inputs.
- **SC-005**: An operator can take a brand-new project to a working deployment, with a healthy readiness check, in under 30 minutes.
- **SC-006**: 100% of notifications requested for an unknown device key, invalid parameter, or expired credential fail with a message that names the cause; the operator needs no more than 5 minutes to diagnose a single missing notification from the recorded delivery outcomes.
- **SC-007**: Zero notifications are delivered to a device other than the addressed one across an audit of all delivery attempts (100% targeting correctness).
- **SC-008**: A burst of 500 requests arriving within 10 seconds results in at least 99% being accepted or explicitly rate-limited (no silent drops) and at least 95% of accepted notifications displayed within 15 seconds.
- **SC-009**: Archived notifications are removed within one hour of their requested lifetime expiring, in 100% of cases, with no manual intervention.
- **SC-010**: Rotating push credentials requires no code change and causes no more than 5 minutes of delivery interruption.

## Assumptions

- **Deployment platform**: The deliverable runs on a hosted Supabase project, with a local Supabase development stack used for iteration. Both rely only on platform-native capabilities — managed database for device and delivery records, serverless request handlers for the client interface, platform secret storage for push credentials, and scheduled work for cleanup and retries. Self-managed long-running processes are not part of the design.
- **Reference behavior**: `Finb/bark-server` and its published interface documentation are the authority for compatible behavior. Where the reference server has undocumented quirks, the documented interface wins.
- **Client**: The official Bark app and the ecosystem tools listed in the reference documentation are used unchanged; the server adapts to them, not the other way around.
- **Push dependency**: Delivery requires an Apple Developer push credential (key, team identifier, app identifier/topic) and reaches Apple's push service directly from the deployment. The operator is responsible for obtaining and rotating these credentials.
- **Environments**: A device token is only valid for the Apple environment that issued it; the deployment targets one environment at a time and this is treated as operator configuration, not per-device input.
- **User model**: The server serves one operator's deployment shared by that operator and the people they invite; there is no billing, plan, or account self-service in scope.
- **Administration**: Operator-facing administration is done through the platform's data console and recorded configuration; no bespoke web dashboard is required.
- **Retention defaults**: Delivery records and archived notifications follow sender-requested lifetimes for content, and a bounded operator-configurable retention window for delivery metadata.
- **Push credentials available**: Apple Developer credentials (push key, team identifier, app identifier) are available at the start of the work, so real-device acceptance testing is not blocked.
- **Registration model**: Self-registration is open, matching the reference server; abuse is contained by rate limits and by the operator's ability to disable a registration, not by an approval workflow.
- **Out of scope for this feature**: the reference server's agent/tool-protocol endpoint, a web user interface, retrieval of message history over the client interface, and compatibility with the reference server's file-based and MySQL storage backends.
- **Data volume**: The deployment is expected to serve tens of devices and up to thousands of notifications per day, which fits comfortably within platform limits; no sharding or multi-region design is required.
