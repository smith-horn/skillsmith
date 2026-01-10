# Enterprise Package Specification

**Version**: 1.0.0
**Status**: Specification Draft
**Estimated Implementation**: 10 weeks (40+ hours)
**Package Name**: `@smith-horn-group/enterprise`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [License Key Validation](#2-license-key-validation)
3. [SSO/SAML Integration](#3-ssosaml-integration)
4. [Audit Logging](#4-audit-logging)
5. [RBAC Implementation](#5-rbac-implementation)
6. [Private Registry Support](#6-private-registry-support)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Appendices](#appendices)

---

## 1. Architecture Overview

### 1.1 Directory Structure

```
packages/enterprise/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                    # Main entry point
│   ├── types.ts                    # Enterprise-specific types
│   │
│   ├── license/
│   │   ├── index.ts
│   │   ├── LicenseValidator.ts     # Core validation logic
│   │   ├── LicenseKeyParser.ts     # JWT/custom key parsing
│   │   ├── OfflineValidator.ts     # Offline validation with cached keys
│   │   ├── KeyRotation.ts          # Automatic key rotation
│   │   └── types.ts
│   │
│   ├── sso/
│   │   ├── index.ts
│   │   ├── SSOManager.ts           # SSO orchestration
│   │   ├── providers/
│   │   │   ├── OktaProvider.ts
│   │   │   ├── AzureADProvider.ts
│   │   │   └── GoogleWorkspaceProvider.ts
│   │   ├── saml/
│   │   │   ├── SAMLParser.ts
│   │   │   ├── SAMLValidator.ts
│   │   │   └── SAMLConfig.ts
│   │   ├── oidc/
│   │   │   ├── OIDCClient.ts
│   │   │   ├── TokenManager.ts
│   │   │   └── JWKSFetcher.ts
│   │   └── types.ts
│   │
│   ├── audit/
│   │   ├── index.ts
│   │   ├── AuditLogger.ts          # Core audit logging
│   │   ├── AuditEventTypes.ts      # Event type definitions
│   │   ├── formatters/
│   │   │   ├── JSONFormatter.ts
│   │   │   ├── SyslogFormatter.ts
│   │   │   └── CEFFormatter.ts
│   │   ├── exporters/
│   │   │   ├── FileExporter.ts
│   │   │   ├── SIEMExporter.ts
│   │   │   └── CloudExporter.ts
│   │   ├── retention/
│   │   │   ├── RetentionPolicy.ts
│   │   │   └── RetentionEnforcer.ts
│   │   └── types.ts
│   │
│   ├── rbac/
│   │   ├── index.ts
│   │   ├── RBACManager.ts          # Role management
│   │   ├── PermissionChecker.ts    # Permission validation
│   │   ├── RoleHierarchy.ts        # Role inheritance
│   │   ├── policies/
│   │   │   ├── PolicyEngine.ts
│   │   │   ├── PolicyLoader.ts
│   │   │   └── DefaultPolicies.ts
│   │   └── types.ts
│   │
│   ├── registry/
│   │   ├── index.ts
│   │   ├── PrivateRegistry.ts      # Registry client
│   │   ├── RegistryAuth.ts         # Registry authentication
│   │   ├── SkillPublisher.ts       # Skill publishing workflow
│   │   ├── RegistrySync.ts         # Sync with private registry
│   │   └── types.ts
│   │
│   └── config/
│       ├── EnterpriseConfig.ts     # Configuration management
│       └── defaults.ts
│
├── tests/
│   ├── fixtures/
│   │   └── license-test-utils.ts    # Test utilities for JWT generation
│   ├── integration/
│   │   └── LicenseValidator.integration.test.ts  # RS256 JWT tests
│   ├── unit/
│   │   ├── license/
│   │   ├── sso/
│   │   ├── audit/
│   │   ├── rbac/
│   │   └── registry/
│   └── e2e/
│
└── docs/
    ├── LICENSE_KEY_FORMAT.md
    ├── SSO_SETUP_GUIDE.md
    ├── AUDIT_LOG_SCHEMA.md
    └── RBAC_CONFIGURATION.md
```

### 1.2 Integration Points with Core Packages

```
┌──────────────────────────────────────────────────────────────────┐
│                     @smith-horn-group/enterprise                   │
├──────────────────────────────────────────────────────────────────┤
│  License  │   SSO    │   Audit   │   RBAC   │  Private Registry  │
└─────┬─────┴────┬─────┴─────┬─────┴────┬─────┴─────────┬──────────┘
      │          │           │          │               │
      ▼          ▼           ▼          ▼               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Integration Layer                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Middleware │  │   Hooks     │  │  Decorators │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
      │                    │                    │
      ▼                    ▼                    ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────────┐
│ @skillsmith │    │ @skillsmith │    │ @skillsmith     │
│   /core     │    │ /mcp-server │    │ /vscode-ext     │
└─────────────┘    └─────────────┘    └─────────────────┘
```

### 1.3 Package Dependencies

```json
{
  "name": "@smith-horn-group/enterprise",
  "version": "0.1.0",
  "dependencies": {
    "@skillsmith/core": "workspace:*",
    "jose": "^5.2.0",
    "saml2-js": "^4.0.0",
    "openid-client": "^5.6.0",
    "better-sqlite3": "^11.0.0",
    "winston": "^3.11.0",
    "zod": "^3.22.0"
  },
  "peerDependencies": {
    "@skillsmith/mcp-server": "workspace:*"
  }
}
```

---

## 2. License Key Validation

### 2.1 Key Format Specification

The enterprise license key uses a JWT-based format with additional security measures.

#### 2.1.1 JWT Structure

```
Header.Payload.Signature
```

**Header**:
```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "skillsmith-enterprise-v1"
}
```

**Payload**:
```json
{
  "iss": "https://license.skillsmith.app",
  "sub": "org_abc123",
  "aud": "skillsmith-enterprise",
  "iat": 1704067200,
  "exp": 1735689599,
  "nbf": 1704067200,
  "jti": "license_uuid_here",
  "license": {
    "type": "enterprise",
    "tier": "professional",
    "seats": 100,
    "features": [
      "sso",
      "audit_logging",
      "rbac",
      "private_registry",
      "priority_support"
    ],
    "org": {
      "id": "org_abc123",
      "name": "Acme Corporation",
      "domain": "acme.com"
    },
    "limits": {
      "maxUsers": 100,
      "maxSkills": 1000,
      "maxPrivateSkills": 500,
      "apiRateLimit": 10000
    }
  },
  "checksum": "sha256_hash_of_payload"
}
```

#### 2.1.2 Alternative Custom Key Format

For environments without JWT support, a custom format is available:

```
SKE-{VERSION}-{ORG_ID}-{TIER}-{EXPIRY}-{FEATURES}-{CHECKSUM}
```

Example:
```
SKE-V1-ORG123ABC-PRO-20251231-SSO+AUDIT+RBAC-A7B3C9D2E4F6
```

### 2.2 Validation Flow

```typescript
interface LicenseValidationResult {
  valid: boolean;
  license?: License;
  error?: LicenseError;
  warnings?: string[];
  validatedAt: Date;
  expiresAt?: Date;
}

interface LicenseValidator {
  // Primary validation (online)
  validate(key: string): Promise<LicenseValidationResult>;

  // Offline validation using cached public keys
  validateOffline(key: string): LicenseValidationResult;

  // Check specific feature availability
  hasFeature(feature: FeatureFlag): boolean;

  // Get current license info
  getLicense(): License | null;

  // Refresh license from server
  refresh(): Promise<LicenseValidationResult>;
}
```

```
┌─────────────────────────────────────────────────────────────────┐
│                     License Validation Flow                      │
└─────────────────────────────────────────────────────────────────┘

     ┌───────────┐
     │ Start     │
     └─────┬─────┘
           │
           ▼
     ┌───────────┐      ┌──────────────┐
     │ Parse Key │──No─▶│ Return Error │
     └─────┬─────┘      └──────────────┘
           │ Yes
           ▼
     ┌───────────────┐
     │ Check Format  │──Invalid─▶ Return Error
     └───────┬───────┘
             │ Valid
             ▼
     ┌───────────────┐      ┌──────────────────┐
     │ Online Check  │──No─▶│ Offline Fallback │
     │   Available?  │      └────────┬─────────┘
     └───────┬───────┘               │
             │ Yes                   │
             ▼                       ▼
     ┌───────────────┐      ┌──────────────────┐
     │ Verify with   │      │ Verify with      │
     │ License API   │      │ Cached Public Key│
     └───────┬───────┘      └────────┬─────────┘
             │                       │
             ▼                       ▼
     ┌───────────────┐      ┌──────────────────┐
     │ Check Expiry  │      │ Check Cache Age  │
     │ & Revocation  │      │ (max 30 days)    │
     └───────┬───────┘      └────────┬─────────┘
             │                       │
             └───────────┬───────────┘
                         ▼
     ┌───────────────────────────────┐
     │ Update Local Cache            │
     │ Store validated license       │
     └───────────────┬───────────────┘
                     ▼
     ┌───────────────────────────────┐
     │ Return LicenseValidationResult│
     └───────────────────────────────┘
```

### 2.3 Offline Validation Support

```typescript
interface OfflineValidatorConfig {
  // Maximum age of cached public key (default: 30 days)
  maxKeyAge: number;

  // Path to embedded public keys for air-gapped environments
  embeddedKeysPath?: string;

  // Grace period after license expiry (default: 7 days)
  gracePeriod: number;

  // Cache storage location
  cachePath: string;
}

class OfflineValidator {
  private publicKeyCache: Map<string, CachedPublicKey>;
  private licenseCache: Map<string, CachedLicense>;

  async validate(key: string): Promise<LicenseValidationResult> {
    // 1. Parse JWT header to get key ID
    const { kid } = this.parseHeader(key);

    // 2. Look up cached public key
    const publicKey = this.publicKeyCache.get(kid);
    if (!publicKey || this.isKeyExpired(publicKey)) {
      return { valid: false, error: 'NO_VALID_PUBLIC_KEY' };
    }

    // 3. Verify signature
    const verified = await this.verifySignature(key, publicKey);
    if (!verified) {
      return { valid: false, error: 'INVALID_SIGNATURE' };
    }

    // 4. Check expiry with grace period
    const payload = this.parsePayload(key);
    const expiryWithGrace = payload.exp + this.config.gracePeriod;
    if (Date.now() / 1000 > expiryWithGrace) {
      return { valid: false, error: 'LICENSE_EXPIRED' };
    }

    return {
      valid: true,
      license: this.extractLicense(payload),
      validatedAt: new Date(),
      expiresAt: new Date(payload.exp * 1000)
    };
  }
}
```

### 2.4 Key Rotation

```typescript
interface KeyRotationConfig {
  // Check for new keys every N hours (default: 24)
  checkInterval: number;

  // Endpoint for fetching new keys
  keyServerUrl: string;

  // Keep N previous keys for validation (default: 2)
  previousKeysToRetain: number;

  // Notification callback for key updates
  onKeyRotation?: (newKeyId: string) => void;
}

class KeyRotationManager {
  private currentKeyId: string;
  private keys: Map<string, PublicKey>;

  async checkForRotation(): Promise<void> {
    const response = await fetch(`${this.config.keyServerUrl}/.well-known/jwks.json`);
    const jwks = await response.json();

    for (const key of jwks.keys) {
      if (!this.keys.has(key.kid)) {
        this.keys.set(key.kid, await this.importKey(key));
        this.config.onKeyRotation?.(key.kid);
      }
    }

    // Prune old keys
    this.pruneOldKeys();
  }

  private pruneOldKeys(): void {
    const keyIds = Array.from(this.keys.keys());
    while (keyIds.length > this.config.previousKeysToRetain + 1) {
      const oldest = keyIds.shift()!;
      if (oldest !== this.currentKeyId) {
        this.keys.delete(oldest);
      }
    }
  }
}
```

---

## 3. SSO/SAML Integration

### 3.1 Supported Providers

| Provider | Protocol | Status |
|----------|----------|--------|
| Okta | SAML 2.0 / OIDC | Priority |
| Azure AD | SAML 2.0 / OIDC | Priority |
| Google Workspace | OIDC | Priority |
| OneLogin | SAML 2.0 | Phase 2 |
| Auth0 | OIDC | Phase 2 |
| Generic SAML | SAML 2.0 | Phase 2 |
| Generic OIDC | OIDC | Phase 2 |

### 3.2 SAML Configuration

#### 3.2.1 Service Provider Metadata

```xml
<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://skillsmith.app/enterprise/saml/metadata">

  <md:SPSSODescriptor
    AuthnRequestsSigned="true"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">

    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate><!-- SP Signing Certificate --></ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>

    <md:KeyDescriptor use="encryption">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate><!-- SP Encryption Certificate --></ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>

    <md:SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://skillsmith.app/enterprise/saml/logout"/>

    <md:NameIDFormat>
      urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
    </md:NameIDFormat>

    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://skillsmith.app/enterprise/saml/acs"
      index="0"
      isDefault="true"/>

  </md:SPSSODescriptor>
</md:EntityDescriptor>
```

#### 3.2.2 Configuration Interface

```typescript
interface SAMLConfig {
  // Service Provider settings
  sp: {
    entityId: string;
    assertionConsumerServiceUrl: string;
    singleLogoutServiceUrl: string;
    privateKey: string;
    certificate: string;
    signAuthnRequest: boolean;
    wantAssertionsSigned: boolean;
    wantResponseSigned: boolean;
  };

  // Identity Provider settings
  idp: {
    entityId: string;
    singleSignOnServiceUrl: string;
    singleLogoutServiceUrl?: string;
    certificate: string;
    certificateFingerprint?: string;
  };

  // Attribute mapping
  attributeMapping: {
    email: string;        // e.g., 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
    firstName: string;    // e.g., 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
    lastName: string;     // e.g., 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'
    groups?: string;      // e.g., 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'
    role?: string;        // Custom attribute for role
  };

  // Session settings
  session: {
    maxAge: number;       // Session lifetime in seconds
    idleTimeout: number;  // Idle timeout in seconds
  };
}
```

### 3.3 OIDC Support

```typescript
interface OIDCConfig {
  // Provider settings
  issuer: string;
  clientId: string;
  clientSecret: string;

  // Endpoints (auto-discovered if issuer supports .well-known)
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  jwksUri?: string;
  endSessionEndpoint?: string;

  // Scopes
  scopes: string[];  // ['openid', 'profile', 'email', 'groups']

  // Callbacks
  redirectUri: string;
  postLogoutRedirectUri: string;

  // Token settings
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';

  // Claims mapping
  claimsMapping: {
    email: string;
    name: string;
    groups?: string;
    roles?: string;
  };
}

class OIDCClient {
  private issuer: Issuer;
  private client: Client;

  async initialize(): Promise<void> {
    this.issuer = await Issuer.discover(this.config.issuer);
    this.client = new this.issuer.Client({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uris: [this.config.redirectUri],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.tokenEndpointAuthMethod,
    });
  }

  getAuthorizationUrl(state: string, nonce: string): string {
    return this.client.authorizationUrl({
      scope: this.config.scopes.join(' '),
      state,
      nonce,
    });
  }

  async handleCallback(
    params: CallbackParams,
    state: string,
    nonce: string
  ): Promise<TokenSet> {
    return this.client.callback(
      this.config.redirectUri,
      params,
      { state, nonce }
    );
  }

  async getUserInfo(accessToken: string): Promise<UserInfo> {
    return this.client.userinfo(accessToken);
  }
}
```

### 3.4 Provider-Specific Implementations

#### 3.4.1 Okta Provider

```typescript
class OktaProvider implements SSOProvider {
  private config: OktaConfig;

  async initialize(config: OktaConfig): Promise<void> {
    this.config = config;
    // Validate Okta domain
    if (!config.domain.endsWith('.okta.com') &&
        !config.domain.endsWith('.oktapreview.com')) {
      throw new Error('Invalid Okta domain');
    }
  }

  getSAMLConfig(): SAMLConfig {
    return {
      idp: {
        entityId: `http://www.okta.com/${this.config.oktaAppId}`,
        singleSignOnServiceUrl: `https://${this.config.domain}/app/${this.config.appName}/${this.config.oktaAppId}/sso/saml`,
        certificate: this.config.idpCertificate,
      },
      // ... SP config
    };
  }

  getOIDCConfig(): OIDCConfig {
    return {
      issuer: `https://${this.config.domain}/oauth2/default`,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      scopes: ['openid', 'profile', 'email', 'groups'],
      // ...
    };
  }
}
```

#### 3.4.2 Azure AD Provider

```typescript
class AzureADProvider implements SSOProvider {
  private config: AzureADConfig;

  getSAMLConfig(): SAMLConfig {
    return {
      idp: {
        entityId: `https://sts.windows.net/${this.config.tenantId}/`,
        singleSignOnServiceUrl: `https://login.microsoftonline.com/${this.config.tenantId}/saml2`,
        certificate: this.config.idpCertificate,
      },
      attributeMapping: {
        email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
        lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
        groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
      },
      // ...
    };
  }

  getOIDCConfig(): OIDCConfig {
    return {
      issuer: `https://login.microsoftonline.com/${this.config.tenantId}/v2.0`,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      scopes: ['openid', 'profile', 'email', 'User.Read', 'GroupMember.Read.All'],
      // ...
    };
  }
}
```

---

## 4. Audit Logging

### 4.1 Events to Capture

#### 4.1.1 Authentication Events

| Event Type | Description | Severity |
|------------|-------------|----------|
| `AUTH_LOGIN_SUCCESS` | Successful user login | INFO |
| `AUTH_LOGIN_FAILURE` | Failed login attempt | WARNING |
| `AUTH_LOGOUT` | User logout | INFO |
| `AUTH_SESSION_EXPIRED` | Session expiration | INFO |
| `AUTH_SSO_INITIATED` | SSO flow started | INFO |
| `AUTH_SSO_COMPLETED` | SSO flow completed | INFO |
| `AUTH_SSO_FAILED` | SSO flow failed | WARNING |
| `AUTH_TOKEN_REFRESH` | Token refreshed | DEBUG |
| `AUTH_MFA_REQUIRED` | MFA challenge issued | INFO |
| `AUTH_MFA_SUCCESS` | MFA challenge passed | INFO |
| `AUTH_MFA_FAILURE` | MFA challenge failed | WARNING |

#### 4.1.2 Authorization Events

| Event Type | Description | Severity |
|------------|-------------|----------|
| `AUTHZ_ACCESS_GRANTED` | Access granted to resource | DEBUG |
| `AUTHZ_ACCESS_DENIED` | Access denied to resource | WARNING |
| `AUTHZ_ROLE_CHANGED` | User role changed | INFO |
| `AUTHZ_PERMISSION_GRANTED` | Permission granted | INFO |
| `AUTHZ_PERMISSION_REVOKED` | Permission revoked | INFO |
| `AUTHZ_ELEVATION_REQUEST` | Privilege elevation requested | WARNING |
| `AUTHZ_ELEVATION_APPROVED` | Privilege elevation approved | INFO |

#### 4.1.3 Skill Operations

| Event Type | Description | Severity |
|------------|-------------|----------|
| `SKILL_SEARCH` | Skill search performed | DEBUG |
| `SKILL_VIEW` | Skill details viewed | DEBUG |
| `SKILL_INSTALL` | Skill installed | INFO |
| `SKILL_UNINSTALL` | Skill uninstalled | INFO |
| `SKILL_UPDATE` | Skill updated | INFO |
| `SKILL_PUBLISH` | Skill published to registry | INFO |
| `SKILL_UNPUBLISH` | Skill removed from registry | INFO |
| `SKILL_VALIDATION_FAILED` | Skill validation failed | WARNING |
| `SKILL_SECURITY_ALERT` | Security issue detected | CRITICAL |

#### 4.1.4 Administrative Events

| Event Type | Description | Severity |
|------------|-------------|----------|
| `ADMIN_USER_CREATED` | New user created | INFO |
| `ADMIN_USER_DELETED` | User deleted | WARNING |
| `ADMIN_USER_SUSPENDED` | User suspended | WARNING |
| `ADMIN_CONFIG_CHANGED` | Configuration changed | INFO |
| `ADMIN_LICENSE_UPDATED` | License updated | INFO |
| `ADMIN_REGISTRY_CONFIGURED` | Registry settings changed | INFO |
| `ADMIN_SSO_CONFIGURED` | SSO settings changed | INFO |
| `ADMIN_AUDIT_EXPORT` | Audit logs exported | INFO |

### 4.2 Log Format

#### 4.2.1 JSON Format (Primary)

```json
{
  "timestamp": "2025-01-02T10:30:45.123Z",
  "version": "1.0",
  "eventId": "evt_a1b2c3d4e5f6",
  "eventType": "AUTH_LOGIN_SUCCESS",
  "severity": "INFO",
  "source": {
    "component": "sso",
    "version": "0.1.0",
    "instance": "skillsmith-enterprise-1"
  },
  "actor": {
    "type": "user",
    "id": "usr_abc123",
    "email": "user@acme.com",
    "ip": "192.168.1.100",
    "userAgent": "Mozilla/5.0 ...",
    "sessionId": "sess_xyz789"
  },
  "resource": {
    "type": "session",
    "id": "sess_xyz789",
    "name": null
  },
  "action": {
    "name": "login",
    "method": "sso_saml",
    "provider": "okta"
  },
  "outcome": {
    "status": "success",
    "reason": null,
    "duration": 234
  },
  "context": {
    "organizationId": "org_abc123",
    "environment": "production",
    "correlationId": "corr_123abc",
    "requestId": "req_456def"
  },
  "metadata": {
    "samlAssertion": "truncated...",
    "attributes": {
      "groups": ["developers", "admins"]
    }
  }
}
```

#### 4.2.2 Syslog Format (RFC 5424)

```
<14>1 2025-01-02T10:30:45.123Z skillsmith-enterprise sso - AUTH_LOGIN_SUCCESS [actor@51234 id="usr_abc123" email="user@acme.com" ip="192.168.1.100"][resource@51234 type="session" id="sess_xyz789"][outcome@51234 status="success" duration="234"] User login successful via SAML SSO
```

#### 4.2.3 CEF Format (Common Event Format)

```
CEF:0|Skillsmith|Enterprise|0.1.0|AUTH_LOGIN_SUCCESS|User Login Success|3|src=192.168.1.100 suser=user@acme.com suid=usr_abc123 cs1=okta cs1Label=ssoProvider cs2=saml cs2Label=authMethod outcome=success
```

### 4.3 Retention Policies

```typescript
interface RetentionPolicy {
  // Policy identifier
  id: string;
  name: string;

  // Event types this policy applies to
  eventTypes: string[] | '*';

  // Severity levels to retain
  severities: ('DEBUG' | 'INFO' | 'WARNING' | 'CRITICAL')[];

  // Retention duration
  retention: {
    duration: number;      // Days to retain
    archiveDuration?: number;  // Days to keep in archive (optional)
  };

  // Compliance requirements
  compliance?: {
    standard: 'SOC2' | 'HIPAA' | 'GDPR' | 'PCI-DSS';
    requirement: string;
  };

  // Actions when policy triggers
  actions: {
    onExpiry: 'delete' | 'archive' | 'anonymize';
    archiveLocation?: string;
    notifyBeforeDays?: number;
  };
}

// Default retention policies
const DEFAULT_POLICIES: RetentionPolicy[] = [
  {
    id: 'security-events',
    name: 'Security Events',
    eventTypes: ['AUTH_*', 'AUTHZ_*'],
    severities: ['INFO', 'WARNING', 'CRITICAL'],
    retention: { duration: 365, archiveDuration: 2555 },  // 1 year active, 7 years archive
    compliance: { standard: 'SOC2', requirement: 'CC6.1' },
    actions: { onExpiry: 'archive', notifyBeforeDays: 30 }
  },
  {
    id: 'admin-events',
    name: 'Administrative Events',
    eventTypes: ['ADMIN_*'],
    severities: ['INFO', 'WARNING', 'CRITICAL'],
    retention: { duration: 730 },  // 2 years
    actions: { onExpiry: 'archive' }
  },
  {
    id: 'operational-events',
    name: 'Operational Events',
    eventTypes: ['SKILL_*'],
    severities: ['INFO', 'WARNING', 'CRITICAL'],
    retention: { duration: 90 },  // 90 days
    actions: { onExpiry: 'delete' }
  },
  {
    id: 'debug-events',
    name: 'Debug Events',
    eventTypes: '*',
    severities: ['DEBUG'],
    retention: { duration: 7 },  // 7 days
    actions: { onExpiry: 'delete' }
  }
];
```

### 4.4 Export Capabilities

```typescript
interface AuditExporter {
  // Export to file
  exportToFile(
    query: AuditQuery,
    options: FileExportOptions
  ): Promise<ExportResult>;

  // Export to SIEM (Splunk, Elastic, etc.)
  exportToSIEM(
    config: SIEMConfig
  ): Promise<SIEMConnection>;

  // Export to cloud storage (S3, GCS, Azure Blob)
  exportToCloud(
    query: AuditQuery,
    destination: CloudStorageConfig
  ): Promise<ExportResult>;

  // Stream real-time events
  createEventStream(
    filter: EventFilter
  ): AsyncIterable<AuditEvent>;
}

interface FileExportOptions {
  format: 'json' | 'csv' | 'syslog' | 'cef';
  compression?: 'gzip' | 'zip' | 'none';
  encryption?: {
    algorithm: 'aes-256-gcm';
    key: string;
  };
  splitBy?: 'day' | 'size' | 'count';
  maxFileSize?: number;  // bytes
  maxRecords?: number;
}

interface SIEMConfig {
  type: 'splunk' | 'elastic' | 'sentinel' | 'sumo' | 'generic';
  endpoint: string;
  credentials: {
    type: 'token' | 'basic' | 'certificate';
    token?: string;
    username?: string;
    password?: string;
    certificate?: string;
  };
  index?: string;
  sourcetype?: string;
  batchSize?: number;
  flushInterval?: number;
}
```

---

## 5. RBAC Implementation

### 5.1 Role Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                        Role Hierarchy                            │
└─────────────────────────────────────────────────────────────────┘

                         ┌──────────┐
                         │  admin   │  Full system access
                         └────┬─────┘
                              │ inherits
                    ┌─────────┴─────────┐
                    ▼                   ▼
              ┌──────────┐        ┌───────────┐
              │ manager  │        │ publisher │  Skill publishing
              └────┬─────┘        └───────────┘
                   │ inherits
                   ▼
              ┌──────────┐
              │   user   │  Standard access
              └────┬─────┘
                   │ inherits
                   ▼
              ┌──────────┐
              │  viewer  │  Read-only access
              └──────────┘
```

### 5.2 Permission Matrix

| Permission | Admin | Manager | Publisher | User | Viewer |
|------------|:-----:|:-------:|:---------:|:----:|:------:|
| **Skills** |
| `skill:search` | Y | Y | Y | Y | Y |
| `skill:view` | Y | Y | Y | Y | Y |
| `skill:install` | Y | Y | Y | Y | N |
| `skill:uninstall` | Y | Y | Y | Y | N |
| `skill:publish` | Y | Y | Y | N | N |
| `skill:unpublish` | Y | Y | Y | N | N |
| `skill:approve` | Y | Y | N | N | N |
| `skill:reject` | Y | Y | N | N | N |
| **Users** |
| `user:view` | Y | Y | N | N | N |
| `user:create` | Y | N | N | N | N |
| `user:update` | Y | Y | N | N | N |
| `user:delete` | Y | N | N | N | N |
| `user:suspend` | Y | Y | N | N | N |
| `user:role:assign` | Y | N | N | N | N |
| **Registry** |
| `registry:view` | Y | Y | Y | Y | Y |
| `registry:configure` | Y | N | N | N | N |
| `registry:sync` | Y | Y | N | N | N |
| **Audit** |
| `audit:view` | Y | Y | N | N | N |
| `audit:export` | Y | N | N | N | N |
| `audit:configure` | Y | N | N | N | N |
| **Settings** |
| `settings:view` | Y | Y | N | N | N |
| `settings:update` | Y | N | N | N | N |
| `settings:sso:configure` | Y | N | N | N | N |
| `settings:license:manage` | Y | N | N | N | N |

### 5.3 API for Role Management

```typescript
interface RBACManager {
  // Role operations
  createRole(role: RoleDefinition): Promise<Role>;
  updateRole(roleId: string, updates: Partial<RoleDefinition>): Promise<Role>;
  deleteRole(roleId: string): Promise<void>;
  getRole(roleId: string): Promise<Role | null>;
  listRoles(): Promise<Role[]>;

  // User-role assignment
  assignRole(userId: string, roleId: string): Promise<void>;
  revokeRole(userId: string, roleId: string): Promise<void>;
  getUserRoles(userId: string): Promise<Role[]>;
  getUsersWithRole(roleId: string): Promise<User[]>;

  // Permission checking
  hasPermission(userId: string, permission: Permission): Promise<boolean>;
  hasAnyPermission(userId: string, permissions: Permission[]): Promise<boolean>;
  hasAllPermissions(userId: string, permissions: Permission[]): Promise<boolean>;
  getEffectivePermissions(userId: string): Promise<Permission[]>;

  // Role hierarchy
  getParentRoles(roleId: string): Promise<Role[]>;
  getChildRoles(roleId: string): Promise<Role[]>;
  getInheritedPermissions(roleId: string): Promise<Permission[]>;
}

interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  inheritsFrom?: string[];  // Parent role IDs
  conditions?: RoleCondition[];
  metadata?: Record<string, unknown>;
}

interface RoleCondition {
  // Attribute-based conditions
  attribute: string;  // e.g., 'resource.owner', 'actor.department'
  operator: 'eq' | 'ne' | 'in' | 'nin' | 'contains' | 'matches';
  value: unknown;
}

// Usage examples
const rbac = new RBACManager(config);

// Check permission
if (await rbac.hasPermission(userId, 'skill:publish')) {
  // Allow publishing
}

// Check with condition
const canEdit = await rbac.hasPermission(userId, {
  permission: 'skill:update',
  conditions: {
    'resource.author': userId  // Only own skills
  }
});

// Middleware integration
const requirePermission = (permission: Permission) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    if (!userId || !await rbac.hasPermission(userId, permission)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
};

// Route protection
app.post('/skills',
  requirePermission('skill:publish'),
  skillController.publish
);
```

### 5.4 Policy Engine

```typescript
interface PolicyEngine {
  // Policy evaluation
  evaluate(
    actor: Actor,
    action: Action,
    resource: Resource,
    context?: EvaluationContext
  ): Promise<PolicyDecision>;

  // Policy management
  addPolicy(policy: Policy): Promise<void>;
  removePolicy(policyId: string): Promise<void>;
  updatePolicy(policyId: string, updates: Partial<Policy>): Promise<void>;
  listPolicies(): Promise<Policy[]>;
}

interface Policy {
  id: string;
  name: string;
  effect: 'allow' | 'deny';
  priority: number;  // Higher priority evaluated first

  // Who this policy applies to
  principals: PrincipalMatch[];

  // What actions are covered
  actions: string[];  // Wildcard supported: 'skill:*'

  // What resources are affected
  resources: ResourceMatch[];

  // When the policy applies
  conditions?: PolicyCondition[];
}

// Example policies
const policies: Policy[] = [
  {
    id: 'deny-unverified-install',
    name: 'Prevent installing unverified skills',
    effect: 'deny',
    priority: 100,
    principals: [{ role: 'user' }, { role: 'viewer' }],
    actions: ['skill:install'],
    resources: [{ type: 'skill', condition: { trustTier: 'unverified' } }],
    conditions: []
  },
  {
    id: 'allow-own-skills',
    name: 'Allow users to manage their own skills',
    effect: 'allow',
    priority: 50,
    principals: [{ role: '*' }],
    actions: ['skill:update', 'skill:unpublish'],
    resources: [{ type: 'skill' }],
    conditions: [
      { attribute: 'resource.author', operator: 'eq', value: '${actor.id}' }
    ]
  }
];
```

---

## 6. Private Registry Support

### 6.1 Registry Configuration

```typescript
interface PrivateRegistryConfig {
  // Registry identification
  id: string;
  name: string;
  description?: string;

  // Connection settings
  url: string;
  apiVersion: 'v1' | 'v2';

  // Authentication
  auth: RegistryAuth;

  // Behavior settings
  settings: {
    // Primary or fallback registry
    priority: 'primary' | 'fallback';

    // Sync with public registry
    syncPublic: boolean;
    syncInterval?: number;  // minutes

    // Caching
    cacheEnabled: boolean;
    cacheTTL?: number;  // seconds

    // Rate limiting
    rateLimit?: {
      requests: number;
      window: number;  // seconds
    };
  };

  // Allowed skill sources
  allowedSources: {
    internal: boolean;     // Skills from this org
    verified: boolean;     // Verified public skills
    community: boolean;    // Community public skills
    external: boolean;     // Any external skills
  };
}

interface RegistryAuth {
  type: 'bearer' | 'basic' | 'oauth2' | 'mtls';

  // Bearer token
  token?: string;

  // Basic auth
  username?: string;
  password?: string;

  // OAuth2
  oauth?: {
    clientId: string;
    clientSecret: string;
    tokenUrl: string;
    scopes?: string[];
  };

  // Mutual TLS
  mtls?: {
    clientCert: string;
    clientKey: string;
    caCert?: string;
  };
}
```

### 6.2 Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                  Private Registry Auth Flow                      │
└─────────────────────────────────────────────────────────────────┘

  ┌──────────┐     ┌───────────┐     ┌─────────────────┐
  │ Skillsmith│     │ Auth      │     │ Private         │
  │ Client    │     │ Provider  │     │ Registry        │
  └─────┬─────┘     └─────┬─────┘     └────────┬────────┘
        │                 │                     │
        │  1. Request Token                     │
        │────────────────▶│                     │
        │                 │                     │
        │  2. Token (JWT) │                     │
        │◀────────────────│                     │
        │                 │                     │
        │  3. API Request with Token            │
        │──────────────────────────────────────▶│
        │                 │                     │
        │                 │  4. Validate Token  │
        │                 │◀────────────────────│
        │                 │                     │
        │                 │  5. Token Valid     │
        │                 │────────────────────▶│
        │                 │                     │
        │  6. API Response                      │
        │◀──────────────────────────────────────│
        │                 │                     │
```

### 6.3 Skill Publishing Workflow

```typescript
interface SkillPublisher {
  // Validate skill before publishing
  validate(skill: SkillPackage): Promise<ValidationResult>;

  // Publish to private registry
  publish(
    skill: SkillPackage,
    options?: PublishOptions
  ): Promise<PublishResult>;

  // Update existing skill
  update(
    skillId: string,
    skill: SkillPackage,
    options?: UpdateOptions
  ): Promise<UpdateResult>;

  // Unpublish/deprecate skill
  unpublish(
    skillId: string,
    reason?: string
  ): Promise<void>;

  // Get publishing status
  getStatus(skillId: string): Promise<PublishStatus>;
}

interface PublishOptions {
  // Visibility
  visibility: 'private' | 'organization' | 'public';

  // Version handling
  version: string;
  versionBump?: 'major' | 'minor' | 'patch';

  // Review requirements
  requireReview: boolean;
  reviewers?: string[];

  // Documentation
  changelog?: string;
  releaseNotes?: string;

  // Tags and categories
  tags?: string[];
  category?: SkillCategory;
}

interface PublishResult {
  success: boolean;
  skillId: string;
  version: string;
  publishedAt: Date;
  registryUrl: string;
  status: 'published' | 'pending_review' | 'rejected';
  reviewId?: string;
}
```

### 6.4 Publishing Workflow States

```
┌─────────────────────────────────────────────────────────────────┐
│                    Skill Publishing Workflow                     │
└─────────────────────────────────────────────────────────────────┘

  ┌────────┐
  │ Draft  │
  └───┬────┘
      │ submit
      ▼
  ┌────────────┐     ┌──────────┐
  │ Validating │────▶│ Invalid  │ (fix required)
  └─────┬──────┘     └──────────┘
        │ valid
        ▼
  ┌────────────────┐
  │ Pending Review │◀──────────────┐
  └───────┬────────┘               │
          │                        │
    ┌─────┴─────┐                  │
    ▼           ▼                  │
┌────────┐  ┌──────────┐           │
│Approved│  │ Rejected │───────────┘
└───┬────┘  └──────────┘  (revise and resubmit)
    │ publish
    ▼
┌───────────┐
│ Published │
└─────┬─────┘
      │
      ├─────── update ──▶ (new version cycle)
      │
      ├─────── deprecate
      ▼
┌────────────┐
│ Deprecated │
└────────────┘
```

---

## 7. Implementation Roadmap

### 7.1 Phase Overview

| Phase | Focus | Duration | Dependencies | Status |
|-------|-------|----------|--------------|--------|
| 1 | License Validation | Week 1-2 | None | ✅ Complete |
| 2 | Audit Logging | Week 3-4 | Phase 1 | Pending |
| 3 | SSO/SAML | Week 5-6 | Phase 1, 2 | Pending |
| 4 | RBAC | Week 7-8 | Phase 3 | Pending |
| 5 | Private Registry | Week 9-10 | Phase 4 | Pending |

### 7.2 Phase 1: License Validation (Week 1-2)

**Week 1: Core Implementation**
- [x] Set up `packages/enterprise` package structure
- [x] Implement JWT parsing and validation (RS256)
- [x] Create `LicenseValidator` class (uses jose library)
- [x] Implement online validation against license API
- [x] Add license caching mechanism (public key caching with TTL)
- [x] Unit tests for validation logic

**Week 2: Offline & Advanced Features**
- [x] Implement offline validation with cached public keys
- [x] Add key rotation support (clearKeyCache method)
- [x] Create grace period handling (clock tolerance)
- [x] Add feature flag checking (hasFeature with tier defaults)
- [x] Integration with @skillsmith/core
- [x] Integration tests for license flows (26 tests in tests/integration/)
- [x] Documentation (README.md testing section)

**Deliverables:**
- `@skillsmith/enterprise` package initialized
- Working license validation (online/offline)
- Key rotation mechanism
- 90%+ test coverage

### 7.3 Phase 2: Audit Logging (Week 3-4)

**Week 3: Core Audit System**
- [ ] Design audit event schema
- [ ] Implement `AuditLogger` class
- [ ] Create event type definitions
- [ ] Build JSON formatter
- [ ] Set up SQLite storage for audit logs
- [ ] Add retention policy framework
- [ ] Unit tests

**Week 4: Advanced Features & Export**
- [ ] Implement Syslog formatter
- [ ] Add CEF formatter
- [ ] Create file exporter
- [ ] Build SIEM integration (Splunk/Elastic)
- [ ] Add cloud storage export
- [ ] Implement real-time event streaming
- [ ] Integration with license module
- [ ] E2E tests for audit flows
- [ ] Documentation

**Deliverables:**
- Complete audit logging system
- Multiple output formats
- Export capabilities
- Retention management

### 7.4 Phase 3: SSO/SAML (Week 5-6)

**Week 5: SAML Implementation**
- [ ] Implement SAML parser
- [ ] Create SP metadata generator
- [ ] Build assertion consumer service
- [ ] Add signature validation
- [ ] Implement attribute mapping
- [ ] Create session management
- [ ] Unit tests for SAML flows

**Week 6: OIDC & Provider Integration**
- [ ] Implement OIDC client
- [ ] Add token management
- [ ] Create Okta provider
- [ ] Create Azure AD provider
- [ ] Create Google Workspace provider
- [ ] Build SSO manager orchestration
- [ ] Integration with audit logging
- [ ] E2E tests with mock IdP
- [ ] Documentation

**Deliverables:**
- Working SAML 2.0 implementation
- OIDC support
- Three major provider integrations
- SSO configuration UI specs

### 7.5 Phase 4: RBAC (Week 7-8)

**Week 7: Core RBAC**
- [ ] Design role schema
- [ ] Implement role hierarchy
- [ ] Create permission checker
- [ ] Build role manager API
- [ ] Add user-role assignment
- [ ] Implement permission inheritance
- [ ] Unit tests

**Week 8: Policy Engine & Integration**
- [ ] Implement policy engine
- [ ] Create policy loader
- [ ] Add default policies
- [ ] Build condition evaluator
- [ ] Integrate with SSO for role mapping
- [ ] Add audit logging for authz events
- [ ] Create middleware for route protection
- [ ] E2E tests
- [ ] Documentation

**Deliverables:**
- Complete RBAC system
- Policy engine
- Middleware integration
- Role management API

### 7.6 Phase 5: Private Registry (Week 9-10)

**Week 9: Registry Client**
- [ ] Design registry API spec
- [ ] Implement registry client
- [ ] Add authentication handlers
- [ ] Build skill publisher
- [ ] Create validation pipeline
- [ ] Implement version management
- [ ] Unit tests

**Week 10: Sync & Integration**
- [ ] Add registry synchronization
- [ ] Implement caching layer
- [ ] Create review workflow
- [ ] Build deprecation handling
- [ ] Integrate with RBAC for publish permissions
- [ ] Add audit logging for publish events
- [ ] E2E tests with mock registry
- [ ] Final integration testing
- [ ] Documentation
- [ ] Release preparation

**Deliverables:**
- Private registry client
- Skill publishing workflow
- Registry synchronization
- Complete enterprise package

---

## Appendices

### Appendix A: Type Definitions

```typescript
// license/types.ts
export interface License {
  id: string;
  type: 'enterprise' | 'professional' | 'team';
  tier: 'basic' | 'professional' | 'enterprise';
  organization: Organization;
  features: FeatureFlag[];
  limits: LicenseLimits;
  issuedAt: Date;
  expiresAt: Date;
  validatedAt: Date;
}

export type FeatureFlag =
  | 'sso'
  | 'saml'
  | 'oidc'
  | 'audit_logging'
  | 'rbac'
  | 'private_registry'
  | 'priority_support'
  | 'custom_branding'
  | 'api_access'
  | 'advanced_analytics';

export interface LicenseLimits {
  maxUsers: number;
  maxSkills: number;
  maxPrivateSkills: number;
  apiRateLimit: number;
  storageGB: number;
  retentionDays: number;
}

// audit/types.ts
export interface AuditEvent {
  id: string;
  timestamp: Date;
  eventType: string;
  severity: Severity;
  actor: Actor;
  resource?: Resource;
  action: Action;
  outcome: Outcome;
  context: EventContext;
  metadata?: Record<string, unknown>;
}

export type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'CRITICAL';

// rbac/types.ts
export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
  inheritsFrom: string[];
  conditions?: RoleCondition[];
  createdAt: Date;
  updatedAt: Date;
}

export type Permission = string;  // e.g., 'skill:publish', 'user:create'

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  matchedPolicy?: string;
  evaluationTime: number;
}

// registry/types.ts
export interface SkillPackage {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  content: string;  // Base64 encoded
  manifest: SkillManifest;
  checksum: string;
}

export interface PublishStatus {
  skillId: string;
  version: string;
  status: 'draft' | 'validating' | 'pending_review' | 'approved' | 'rejected' | 'published' | 'deprecated';
  reviewId?: string;
  reviewComments?: string;
  publishedAt?: Date;
  reviewedBy?: string;
}
```

### Appendix B: Configuration Schema

```yaml
# enterprise-config.yaml
license:
  key: ${SKILLSMITH_LICENSE_KEY}
  validation:
    mode: online  # online | offline | hybrid
    cacheEnabled: true
    cacheTTL: 86400  # 24 hours
    gracePeriod: 604800  # 7 days
  keyRotation:
    enabled: true
    checkInterval: 86400  # 24 hours

sso:
  enabled: true
  provider: okta  # okta | azure | google | saml | oidc

  okta:
    domain: ${OKTA_DOMAIN}
    clientId: ${OKTA_CLIENT_ID}
    clientSecret: ${OKTA_CLIENT_SECRET}

  azure:
    tenantId: ${AZURE_TENANT_ID}
    clientId: ${AZURE_CLIENT_ID}
    clientSecret: ${AZURE_CLIENT_SECRET}

  saml:
    entityId: https://skillsmith.app/enterprise/saml
    assertionConsumerServiceUrl: https://skillsmith.app/enterprise/saml/acs
    idpMetadataUrl: ${IDP_METADATA_URL}

  session:
    maxAge: 28800  # 8 hours
    idleTimeout: 1800  # 30 minutes

audit:
  enabled: true
  format: json  # json | syslog | cef
  storage:
    type: sqlite  # sqlite | postgres | external
    path: ./data/audit.db
  retention:
    default: 90  # days
    security: 365
    admin: 730
  export:
    enabled: true
    destination: s3  # s3 | gcs | azure | file

rbac:
  enabled: true
  defaultRole: viewer
  roleMapping:
    enabled: true
    source: sso  # sso | ldap | custom
    attributeName: groups

registry:
  private:
    enabled: true
    url: https://registry.internal.example.com
    auth:
      type: oauth2
      clientId: ${REGISTRY_CLIENT_ID}
      clientSecret: ${REGISTRY_CLIENT_SECRET}
    sync:
      enabled: true
      interval: 3600  # 1 hour
```

### Appendix C: API Endpoints

```typescript
// Enterprise API endpoints (to be exposed via MCP tools)

// License
GET    /enterprise/license              // Get current license info
POST   /enterprise/license/validate     // Validate license key
POST   /enterprise/license/refresh      // Refresh license from server

// SSO
GET    /enterprise/sso/providers        // List configured providers
GET    /enterprise/sso/saml/metadata    // Get SP metadata
POST   /enterprise/sso/saml/acs         // SAML assertion consumer
GET    /enterprise/sso/oidc/authorize   // OIDC authorization
POST   /enterprise/sso/oidc/callback    // OIDC callback
POST   /enterprise/sso/logout           // SSO logout

// Audit
GET    /enterprise/audit/events         // Query audit events
POST   /enterprise/audit/export         // Export audit logs
GET    /enterprise/audit/policies       // Get retention policies
PUT    /enterprise/audit/policies       // Update retention policies

// RBAC
GET    /enterprise/rbac/roles           // List roles
POST   /enterprise/rbac/roles           // Create role
GET    /enterprise/rbac/roles/:id       // Get role
PUT    /enterprise/rbac/roles/:id       // Update role
DELETE /enterprise/rbac/roles/:id       // Delete role
POST   /enterprise/rbac/check           // Check permission
GET    /enterprise/rbac/users/:id/roles // Get user roles
POST   /enterprise/rbac/users/:id/roles // Assign role
DELETE /enterprise/rbac/users/:id/roles/:roleId // Revoke role

// Registry
GET    /enterprise/registry/config      // Get registry config
PUT    /enterprise/registry/config      // Update registry config
POST   /enterprise/registry/sync        // Trigger sync
GET    /enterprise/registry/skills      // List private skills
POST   /enterprise/registry/skills      // Publish skill
PUT    /enterprise/registry/skills/:id  // Update skill
DELETE /enterprise/registry/skills/:id  // Unpublish skill
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-01-02 | Skillsmith Team | Initial specification |

---

## References

- [JWT RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519)
- [SAML 2.0 Specification](https://docs.oasis-open.org/security/saml/v2.0/)
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 5424 - Syslog Protocol](https://datatracker.ietf.org/doc/html/rfc5424)
- [Common Event Format (CEF)](https://www.microfocus.com/documentation/arcsight/arcsight-smartconnectors-8.4/pdfdoc/cef-implementation-standard/cef-implementation-standard.pdf)
