import { createContext, useContext } from 'react';

export type MerchantRole = 'owner' | 'manager' | 'staff';
export type CurrentMerchant = {
  id: string;
  name: string;
  type: 'individual' | 'business';
  verificationStatus: string;
  role: MerchantRole;
  refresh: () => void;
};
export const MerchantCtx = createContext<CurrentMerchant | null>(null);
export function useMerchant() {
  const m = useContext(MerchantCtx);
  if (!m) throw new Error('useMerchant outside a merchant route');
  return m;
}
/** UI mirror of server rules, used to hide actions a role cannot perform (the server still enforces them). */
export const can = (role: MerchantRole, action: 'manageProducts' | 'ownerOnly' | 'manageTeam') =>
  action === 'ownerOnly' ? role === 'owner' : role === 'owner' || role === 'manager';
