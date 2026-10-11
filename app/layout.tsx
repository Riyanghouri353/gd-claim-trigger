import './globals.css';

export const metadata = {
  title: 'G$ Claim Trigger',
  description: 'Server-side scheduler for GoodDollar auto-claims',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
