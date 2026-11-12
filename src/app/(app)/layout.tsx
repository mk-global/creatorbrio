import { AppProvider } from "@/components/app/AppContext";
import { Shell } from "@/components/app/Shell";

/** Every page of the app shares the shell, the brands and the confirmations (#175). */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
