import "server-only";
import type { Session } from "./session";

/**
 * Only a sign-in method the account already had when this session last
 * proved itself can renew that proof. Otherwise someone at an unattended,
 * signed-in device could add their own passkey and use it to unlock admin
 * changes. (Adding one needs a fresh check too, but this holds on its own.)
 */
export function factorPredates(session: Session): (addedAt: number) => boolean {
  const lastProof = session.verifiedAt ?? session.createdAt;
  return (addedAt) => addedAt <= lastProof;
}
