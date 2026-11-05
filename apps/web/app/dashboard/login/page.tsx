import { ActionForm, Submit } from "../ActionForm";
import { signIn } from "../actions";

export const metadata = { title: "Sign in · SettleKit" };

export default function LoginPage() {
  return (
    <main className="page">
      <section className="card">
        <h1>SettleKit dashboard</h1>
        <p className="muted">Sign in with your merchant secret key.</p>
        <ActionForm action={signIn}>
          <label className="field">
            Secret key
            <input name="key" type="password" autoComplete="off" required placeholder="sk_test_…" />
          </label>
          <Submit>Sign in</Submit>
        </ActionForm>
      </section>
    </main>
  );
}
