import "server-only";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "./config";
import { addPasskey, findPasskey, listPasskeys, markPasskeyUsed, type User } from "./users";

const toTransports = (t: string[]) => t as AuthenticatorTransport[];

export async function registrationOptions(user: User) {
  return generateRegistrationOptions({
    rpName: config.appName,
    rpID: config.rpId,
    userName: user.username,
    userDisplayName: `${user.firstName} ${user.lastName}`,
    userID: new Uint8Array(Buffer.from(user.webauthnUserId, "base64url")),
    attestationType: "none",
    excludeCredentials: listPasskeys(user.id).map((p) => ({ id: p.id, transports: toTransports(p.transports) })),
    // Passkeys verify the person (Face ID, fingerprint, device PIN), which makes this a real second factor.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export async function verifyRegistration(user: User, response: RegistrationResponseJSON, challenge: string) {
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
  });
  if (!verified || !registrationInfo) return false;
  const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
  addPasskey({
    id: credential.id,
    userId: user.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? response.response.transports ?? [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    createdAt: Date.now(),
  });
  return true;
}

export async function authenticationOptions(user: User) {
  return generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: listPasskeys(user.id).map((p) => ({ id: p.id, transports: toTransports(p.transports) })),
    userVerification: "required",
  });
}

export async function verifyAuthentication(user: User, response: AuthenticationResponseJSON, challenge: string) {
  const passkey = findPasskey(user.id, response.id);
  if (!passkey) return false;
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: passkey.counter,
      transports: toTransports(passkey.transports),
    },
    requireUserVerification: true,
  });
  if (!verified) return false;
  markPasskeyUsed(passkey.id, authenticationInfo.newCounter, Date.now());
  return true;
}
