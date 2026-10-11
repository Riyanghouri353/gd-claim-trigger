import Dashboard from '@/components/Dashboard';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main className="wrap">
      <h1>G$ Claim Runner</h1>
      <p className="muted">Parallel server-side GoodDollar claims — all wallets, all chains, at once.</p>
      <Dashboard />
    </main>
  );
}
