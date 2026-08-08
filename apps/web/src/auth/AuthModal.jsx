import { useEffect, useState } from "react";
import { Check, LoaderCircle, Mail, X } from "lucide-react";
import { useAuth } from "./AuthContext";

export function AuthModal({ open, onClose }) {
  const { configured, signInWithEmail } = useAuth();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const runEmailLogin = async (event) => {
    event.preventDefault();
    setError("");
    setLoading("email");
    try {
      await signInWithEmail(email.trim());
      setSent(true);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="auth-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="auth-close" onClick={onClose} aria-label="Close sign in"><X size={19} /></button>
        <div className="auth-brand-mark">↗</div>
        <span className="section-kicker">Join the market</span>
        <h2 id="auth-title">Make your take count.</h2>
        <p>Sign in to build a portfolio, track your positions, and trade from conversations on X.</p>

        {!configured ? (
          <div className="auth-config-note">
            <strong>Supabase connection needed</strong>
            <span>Add the project URL and publishable key to <code>apps/web/.env.local</code> to enable sign-in.</span>
          </div>
        ) : sent ? (
          <div className="auth-success">
            <span><Check size={22} /></span>
            <h3>Check your inbox</h3>
            <p>We sent a secure sign-in link to <strong>{email}</strong>.</p>
            <button onClick={() => setSent(false)}>Use another email</button>
          </div>
        ) : (
          <>
            <form onSubmit={runEmailLogin}>
              <label htmlFor="auth-email">Email address</label>
              <div className="auth-email-input"><Mail size={18} /><input id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required autoFocus /></div>
              <button className="email-auth-button" disabled={Boolean(loading)}>
                {loading === "email" && <LoaderCircle className="spin" size={17} />}
                Email me a sign-in link
              </button>
            </form>
          </>
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <small className="auth-terms">By continuing, you agree this is a demo experience using non-monetary credits.</small>
      </section>
    </div>
  );
}
