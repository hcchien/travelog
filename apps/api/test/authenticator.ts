/**
 * 測試用的軟體 WebAuthn authenticator：產生真正的 ES256 簽章與 attestation，
 * 讓 @simplewebauthn/server 以正式邏輯驗證。
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credentialId = randomBytes(16);
  private counter = 0;
  private userHandle: string | null = null;

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
  ) {}

  private coseKey() {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, isoBase64URL.toBuffer(jwk.x as string)],
        [-3, isoBase64URL.toBuffer(jwk.y as string)],
      ]),
    );
  }

  private authData(flags: number, attested: Buffer | null) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([
      sha256(this.rpId),
      Buffer.from([flags]),
      counter,
      attested ?? Buffer.alloc(0),
    ]);
  }

  // biome-ignore lint/suspicious/noExplicitAny: WebAuthn options JSON
  createCredential(options: any) {
    this.userHandle = options.user.id;
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([
      Buffer.alloc(16),
      idLen,
      this.credentialId,
      Buffer.from(this.coseKey()),
    ]);
    // UP | UV | BE | BS | AT
    const authData = this.authData(0x01 | 0x04 | 0x08 | 0x10 | 0x40, attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: WebAuthn options JSON
  getAssertion(options: any, opts: { challenge?: string } = {}) {
    this.counter += 1;
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: opts.challenge ?? options.challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
    const authData = this.authData(0x01 | 0x04 | 0x08 | 0x10, null);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), {
      key: this.keys.privateKey,
      dsaEncoding: "der",
    });
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
