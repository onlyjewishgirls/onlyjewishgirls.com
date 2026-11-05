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
import { addPasskey, findPasskey, listPasskeys, markPasskeyUsed, type Passkey, type User } from "./users";

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

/** `allow` limits which of the user's passkeys may be used (all of them by default). */
export async function authenticationOptions(req: NextRequest, user: User, allow: (p: Passkey) => boolean = () => true) {
  return generateAuthenticationOptions({
    rpID: site(req).rpID,
    allowCredentials: (await listPasskeys(user.id))
      .filter(allow)
      .map((p) => ({ id: p.id, transports: toTransports(p.transports) })),
    userVerification: "required",
  });
}

export type PasskeyCheck = { ok: true; passkey: Passkey } | { ok: false; reason: string };

/** Checks a passkey assertion and says exactly why it failed (PORTAL-STANDARD §2 `passkey_failed`). */
export async function checkAuthentication(
  req: NextRequest,
  user: User,
  response: AuthenticationResponseJSON,
  challenge: string,
  allow: (p: Passkey) => boolean = () => true,
): Promise<PasskeyCheck> {
  if (!response || typeof response.id !== "string") return { ok: false, reason: "The browser didn't send a passkey response." };
  const passkey = await findPasskey(user.id, response.id);
  if (!passkey) return { ok: false, reason: `That passkey is not registered on the account ${user.username}.` };
  if (!allow(passkey)) return { ok: false, reason: "That passkey was added after this sign-in; use one you had before." };
  return checkWithPasskey(req, passkey, response, challenge);
}

export async function checkWithPasskey(
  req: NextRequest,
  passkey: Passkey,
  response: AuthenticationResponseJSON,
  challenge: string,
): Promise<PasskeyCheck> {
  const { origin, rpID } = site(req);
  try {
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
    if (!verified) return { ok: false, reason: "The passkey's signature is invalid." };
    await markPasskeyUsed(passkey.id, authenticationInfo.newCounter, Date.now());
    return { ok: true, passkey };
  } catch (error) {
    return { ok: false, reason: `The passkey's signature is invalid: ${(error as Error).message}` };
  }
}

export async function verifyAuthentication(
  req: NextRequest,
  user: User,
  response: AuthenticationResponseJSON,
  challenge: string,
  allow: (p: Passkey) => boolean = () => true,
) {
  return (await checkAuthentication(req, user, response, challenge, allow)).ok;
}

/** Usernameless sign-in: any passkey on this site (discoverable credentials). */
export async function discoverableOptions(req: NextRequest) {
  return generateAuthenticationOptions({ rpID: site(req).rpID, allowCredentials: [], userVerification: "required" });
}
