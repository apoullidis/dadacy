/**
 * `@kinvara/core-modules/credential` — the `credential` module's scheme half (T-060, re-scoped by
 * CUT-T-060 R-1): the `credential_scheme` read path (Q-1) with its 60 s in-process cache, the
 * closed `mandatory_rules` parse (R-3), the display-name lookup with an explicit missing locale
 * (R-6), and the reference validator; and its second half (T-255): the `sitter_credential`
 * repository (Q-2…Q-5) under T-254's actor scope (`repository.ts`); and the validity models
 * (T-061): the dates a move to `valid` writes, computed and never written here (`validity.ts`).
 *
 * TWO-APPROVAL PATH (PROTOCOL §3, EV-30): everything under `src/credential/`. This file is the
 * subpath's whole public surface; import it by package name only (a relative path into `src/`
 * bypasses the `exports` map and nothing refuses it, T-245 RW1-C §1 row 2).
 *
 * The contracts are state/EP-5/T-060.md, state/EP-5/T-255.md and state/EP-5/T-061.md, § Published
 * contract — LIVE.
 */
export {
  CHECK_TYPES,
  CredentialSchemeReadError,
  isMandatoryForEverySitter,
  MANDATORY_RULES_UNREADABLE,
  MandatoryRulesUnreadableError,
  MandatoryRulesV1,
  parseMandatoryRules,
  SCHEME_READ_REFUSED,
  VALIDITY_MODELS,
  type CheckType,
  type CredentialScheme,
  type MandatoryRules,
  type ValidityModel,
} from './scheme.ts';
export {
  CredentialSchemeCache,
  JURISDICTION_REFUSED,
  readCredentialSchemes,
  SCHEME_CACHE_TTL_MS,
  SCHEME_READ_REFUSED_LOG,
  type CredentialSchemeCacheOptions,
  type SchemeLoader,
} from './read.ts';
export {
  REFERENCE_PATTERN_UNUSABLE,
  REFERENCE_REFUSED_LOG,
  REFERENCE_REGEX_FLAGS,
  ReferenceNumberRefusedError,
  ReferencePatternUnusableError,
  validateReference,
  type ReferenceOutcome,
  type ReferenceRefusalReason,
} from './reference.ts';
export { schemeDisplayName, type SchemeDisplayName } from './display.ts';
export {
  VALIDITY_NOT_COMPUTED,
  VALIDITY_SCHEME_UNUSABLE,
  validityDatesForDecision,
  ValidityNotComputedError,
  ValiditySchemeUnusableError,
  type ExpiryProvenance,
  type ValidityDates,
  type ValidityFacts,
  type ValidityScheme,
} from './validity.ts';
export {
  CREDENTIAL_ROW_UNREADABLE,
  CREDENTIAL_STATUSES,
  dueForAttestation,
  dueForExpiry,
  dueForRecertification,
  ensureOnboardingCredentials,
  listOwnCredentials,
  REFERENCE_BOUNDS_CONSTRAINT,
  ReferenceNumberOutOfBoundsError,
  SITTER_CREDENTIAL_REFUSED,
  SitterCredentialReadError,
  SitterCredentialRefusedError,
  sitterActor,
  submitCertificate,
  SWEEP_ACTOR_REFUSED,
  SweepActorRefusedError,
  type CertificateSubmission,
  type CredentialStatus,
  type OnboardingResult,
  type SitterActor,
  type SitterCredential,
  type SubmissionOutcome,
} from './repository.ts';
