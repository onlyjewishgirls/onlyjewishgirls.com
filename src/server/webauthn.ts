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
import type { NextRequest } from "next/server";
import { APP_NAME, rpIdFor } from "./env";
import { addPasskey, findPasskey, listPasskeys, markPasskeyUsed, type User } from "./users";

const toTransports = (t: string[]) => t as AuthenticatorTransport[];

/**
 * Passkeys are tied to the site they're used on. The browser puts the page's
 * origin into what it signs, and we check it matches the site the request came
 * to, so a look-alike phishing site can't relay a passkey sign-in.
 */
function site(req: NextRequest) {
  const url = new URL(req.url);
  return { origin: url.origin, rpID: rpIdFor(url.hostname) };
}

export async function registrationOptions(req: NextRequest, user: User) {
  return generateRegistrationOptions({
    rpName: APP_NAME,
    rpID: site(req).rpID,
    userName: user.username,
    userDisplayName: `${user.firstName} ${user.lastName}`,
    userID: new Uint8Array(Buffer.from(user.webauthnUserId, "base64url")),
    attestationType: "none",
    excludeCredentials: (await listPasskeys(user.id)).map((p) => ({ id: p.id, transports: toTransports(p.transports) })),
    // Passkeys verify the person (Face ID, fingerprint, device PIN), which makes this a real second factor.
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export async function verifyRegistration(
  req: NextRequest,
  user: User,
  response: RegistrationResponseJSON,
  challenge: string,
) {
  const { origin, rpID } = site(req);
  const { verified, registrationInfo } = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verified || !registrationInfo) return false;
  const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
  await addPasskey({
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

export async function authenticationOptions(req: NextRequest, user: User) {
  return generateAuthenticationOptions({
    rpID: site(req).rpID,
    allowCredentials: (await listPasskeys(user.id)).map((p) => ({ id: p.id, transports: toTransports(p.transports) })),
    userVerification: "required",
  });
}

export async function verifyAuthentication(
  req: NextRequest,
  user: User,
  response: AuthenticationResponseJSON,
  challenge: string,
) {
  const passkey = await findPasskey(user.id, response.id);
  if (!passkey) return false;
  const { origin, rpID } = site(req);
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: passkey.id,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: passkey.counter,
      transports: toTransports(passkey.transports),
    },
    requireUserVerification: true,
  });
  if (!verified) return false;
  await markPasskeyUsed(passkey.id, authenticationInfo.newCounter, Date.now());
  return true;
}
