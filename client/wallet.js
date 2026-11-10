// Browser bundle for wallet sign-in (built to public/vendor/wallet.js by `npm run build`).
// Wallet discovery uses the Sui Wallet Standard; the account and delegate-key transactions are the
// Walrus Memory SDK's own, signed by the user's wallet.
import { getWallets } from '@mysten/wallet-standard';
import { createAccount, addDelegateKey, generateDelegateKey } from '@mysten-incubation/memwal/account';

const CHAIN = 'sui:mainnet';
const SIGN = 'sui:signAndExecuteTransaction';

const usable = (w) => Boolean(w.features?.['standard:connect'] && w.features?.[SIGN] && (w.chains || []).includes(CHAIN));

/** Installed Sui wallets that can sign on Mainnet. onChange fires when another wallet registers. */
export function listWallets(onChange) {
  const api = getWallets();
  if (onChange) api.on('register', () => onChange(api.get().filter(usable)));
  return api.get().filter(usable);
}

/** Connect a wallet and return a signer the Walrus Memory SDK accepts. */
export async function connect(wallet) {
  const { accounts } = await wallet.features['standard:connect'].connect();
  const account = accounts.find((a) => (a.chains || []).includes(CHAIN)) || accounts[0];
  if (!account) throw new Error('The wallet did not share an account.');
  return {
    address: account.address,
    signAndExecuteTransaction: ({ transaction }) => wallet.features[SIGN].signAndExecuteTransaction({ transaction, account, chain: CHAIN }),
  };
}

export { createAccount, addDelegateKey, generateDelegateKey };
