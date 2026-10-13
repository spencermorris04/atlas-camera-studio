import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ClerkProvider, UserButton, useAuth, useClerk } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CameraTrajectoryPage } from "./trajectory/Editor";
import { authFetchJson, type GetToken } from "./trajectory/client";
import type { Config } from "./types";
import "./styles.css";

type Auth = {
  signedIn: boolean;
  getToken: GetToken;
  openSignIn(): void;
  openProfile(): void;
};
type Account = { credits: number; phoneVerified: boolean };
const localAuth: Auth = {
  signedIn: true,
  getToken: Object.assign(async () => null, { storageScope: "local" }),
  openSignIn() {},
  openProfile() {},
};
class EditorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="loading-screen">
        <p>The editor could not load. Reload to try again.</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Studio({ config, auth }: { config: Config; auth: Auth }) {
  const [queryClient] = useState(() => new QueryClient());
  const [account, setAccount] = useState<Account | null>(null);
  const [toolbarContainer, setToolbarContainer] =
    useState<HTMLDivElement | null>(null);
  const [message, setMessage] = useState(() =>
    new URLSearchParams(location.search).get("checkout") === "success"
      ? "Payment submitted. Your credits will appear once payment is confirmed. You can return to your editor tab."
      : "",
  );
  const [buying, setBuying] = useState(false);
  const [packId, setPackId] = useState("starter");
  const refreshAccount = useCallback(async () => {
    if (!auth.signedIn || config.mode !== "hosted") return;
    try {
      setAccount(await authFetchJson<Account>(auth.getToken, "/api/account"));
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not refresh your credits.",
      );
    }
  }, [auth.signedIn, auth.getToken, config.mode]);
  useEffect(() => {
    void refreshAccount();
    window.addEventListener("focus", refreshAccount);
    window.addEventListener("studio-account-refresh", refreshAccount);
    const timer = window.setInterval(refreshAccount, 15000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshAccount);
      window.removeEventListener("studio-account-refresh", refreshAccount);
    };
  }, [refreshAccount]);
  const ensureAccess = () => {
    if (!config.apiConfigured) {
      setMessage("Add your Marble API key to the server to prepare a scene.");
      return false;
    }
    if (config.mode === "local") return true;
    if (!auth.signedIn) {
      auth.openSignIn();
      return false;
    }
    if (!account) {
      setMessage("Loading your account. Try again in a moment.");
      void refreshAccount();
      return false;
    }
    if (!account.phoneVerified) {
      setMessage(
        "Add and verify a phone number in your account to get started.",
      );
      auth.openProfile();
      return false;
    }
    return true;
  };
  const beforeGenerate = () => {
    if (!ensureAccess()) return false;
    if (config.mode === "hosted" && (account?.credits ?? 0) < 1) {
      setMessage(
        "You have used your free generations. Choose a credit pack to continue.",
      );
      return false;
    }
    setMessage("");
    return true;
  };
  const checkout = async () => {
    if (!ensureAccess() || buying) return;
    const checkoutTab = window.open("about:blank", "_blank");
    if (!checkoutTab) {
      setMessage(
        "Allow pop-ups to open Stripe checkout and keep your scene here.",
      );
      return;
    }
    checkoutTab.opener = null;
    setBuying(true);
    try {
      const result = await authFetchJson<{ url: string }>(
        auth.getToken,
        "/api/checkout",
        { method: "POST", body: JSON.stringify({ packId }) },
      );
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com")
        throw new Error("Checkout returned an unexpected address.");
      checkoutTab.location.href = url.href;
    } catch (error) {
      checkoutTab.close();
      setMessage(
        error instanceof Error ? error.message : "Could not open checkout.",
      );
    } finally {
      setBuying(false);
    }
  };
  return (
    <div className="studio-shell">
      <header className="studio-header flex shrink-0 flex-wrap items-center gap-3 px-3 text-xs md:px-4">
        <span className="studio-brand font-semibold">
          <span className="hidden sm:inline">Atlas Camera Studio</span>
          <span className="sm:hidden">Atlas</span>
        </span>
        <div ref={setToolbarContainer} className="ml-auto" />
        <details className="studio-help relative">
          <summary className="cursor-pointer list-none rounded px-2 py-2 text-[#727b88] hover:text-[#202733]">
            Help
          </summary>
          <nav
            aria-label="Help links"
            className="absolute right-0 top-full z-50 flex w-40 flex-col gap-3 rounded-lg border border-[#e5e9ef] bg-[#ffffff] p-4 shadow-sm"
          >
            {config.repoUrl && (
              <a
                href={config.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="studio-nav-link"
              >
                GitHub
              </a>
            )}
            <a
              href="https://atlas-beta.worldlabs.ai/docs/quickstart"
              target="_blank"
              rel="noreferrer"
              className="studio-nav-link"
            >
              API docs
            </a>
            <a
              href="https://form.typeform.com/to/zHFR4r3A"
              target="_blank"
              rel="noreferrer"
              className="studio-nav-link"
            >
              Get API access
            </a>
          </nav>
        </details>
        {config.mode === "hosted" ? (
          <div className="studio-account-actions flex items-center gap-3">
            {auth.signedIn ? (
              <>
                <button
                  className="studio-credit-balance"
                  onClick={() => void refreshAccount()}
                  title="Refresh credits"
                >
                  {account
                    ? `${account.credits} generation${account.credits === 1 ? "" : "s"}`
                    : "Loading account…"}
                </button>
                {account && !account.phoneVerified && (
                  <button
                    className="studio-verify-button"
                    onClick={auth.openProfile}
                  >
                    Verify phone
                  </button>
                )}
                <select
                  aria-label="Credit pack"
                  value={packId}
                  onChange={(event) => setPackId(event.target.value)}
                  disabled={buying}
                  className="studio-select rounded-lg px-2 py-1.5"
                >
                  {config.creditPacks.map((pack) => (
                    <option key={pack.id} value={pack.id}>
                      {pack.credits} generations · ${pack.priceCents / 100}
                    </option>
                  ))}
                </select>
                <button
                  className="studio-outline-button rounded-lg px-3 py-1.5 disabled:opacity-50"
                  disabled={buying}
                  onClick={() => void checkout()}
                >
                  {buying ? "Opening Stripe…" : "Add credits"}
                </button>
                <UserButton />
              </>
            ) : (
              <button
                className="studio-outline-button rounded-lg px-3 py-1.5"
                onClick={auth.openSignIn}
              >
                Sign in · 3 free generations
              </button>
            )}
          </div>
        ) : null}
      </header>
      {message && (
        <div
          role="status"
          className="studio-notice flex items-center justify-between gap-4 px-5 py-2.5 text-sm"
        >
          <span>{message}</span>
          <button
            className="studio-notice-dismiss"
            aria-label="Dismiss notice"
            onClick={() => setMessage("")}
          >
            ×
          </button>
        </div>
      )}
      <main className="studio-editor">
        <EditorBoundary>
          <QueryClientProvider client={queryClient}>
            <CameraTrajectoryPage
              toolbarContainer={toolbarContainer}
              getToken={auth.getToken}
              canViewHistory={auth.signedIn}
              beforePrepare={ensureAccess}
              beforeGenerate={beforeGenerate}
            />
          </QueryClientProvider>
        </EditorBoundary>
      </main>
    </div>
  );
}
function HostedStudio({ config }: { config: Config }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const clerk = useClerk();
  const scopedGetToken = useMemo(
    () =>
      Object.assign(() => getToken(), { storageScope: userId || "signed-out" }),
    [getToken, userId],
  );
  if (!isLoaded)
    return <div className="loading-screen">Loading your account…</div>;
  return (
    <Studio
      key={userId || "signed-out"}
      config={config}
      auth={{
        signedIn: !!isSignedIn,
        getToken: scopedGetToken,
        openSignIn: () => clerk.openSignIn(),
        openProfile: () => clerk.openUserProfile(),
      }}
    />
  );
}
export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/config")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load app settings.");
        return response.json();
      })
      .then(setConfig)
      .catch((error) => setError(error.message));
  }, []);
  if (!config)
    return (
      <div className="loading-screen">{error || "Loading Camera Studio…"}</div>
    );
  if (config.mode === "local")
    return <Studio config={config} auth={localAuth} />;
  if (!config.clerkPublishableKey)
    return <div className="loading-screen">Sign-in is not configured.</div>;
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <HostedStudio config={config} />
    </ClerkProvider>
  );
}
