import { createContext, useContext } from 'react';
import type { DeviceAccount, Slot } from '../../../core/accounts.ts';

/** Settings → «Аккаунты»: the accounts on this device and the ways between them (from App). */
export interface AccountsApi {
  slot: Slot;
  accounts: DeviceAccount[];
  /** Locks this account and shows the other one's lock screen. */
  switchTo(slot: Slot): void;
  /** Locks this account and opens sign-up / sign-in in the free place. */
  add(): void;
  /** «Скрывать имя на экране входа». */
  setNameHidden(hidden: boolean): Promise<void>;
}

export const AccountsContext = createContext<AccountsApi | null>(null);
export const useAccounts = () => useContext(AccountsContext);
