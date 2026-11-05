"use client";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const ResetPasswordForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        setError(result?.message || "Échec de la réinitialisation");
        setLoading(false);
        return;
      }
      router.push("/auth/signin?reset=1");
    } catch {
      setError("Impossible de contacter le serveur.");
      setLoading(false);
    }
  };

  return (
    <>
      <section className="flex min-h-screen items-center justify-center bg-linear-to-b from-[#f4f7ff] to-white px-4 py-12.5 dark:from-[#0c0e1a] dark:to-black">
        <div className="relative z-1 mx-auto w-full max-w-c-1016 px-7.5 pb-7.5 pt-10 lg:px-15 lg:pt-15 xl:px-20 xl:pt-20">
          <div className="absolute left-0 top-0 -z-1 h-2/3 w-full rounded-lg bg-linear-to-t from-transparent to-[#dee7ff47] dark:bg-linear-to-t dark:to-[#252A42]"></div>
          <div className="absolute bottom-17.5 left-0 -z-1 h-1/3 w-full">
            <Image src="/images/shape/shape-dotted-light.svg" alt="Dotted" className="dark:hidden" fill />
            <Image src="/images/shape/shape-dotted-dark.svg" alt="Dotted" className="hidden dark:block" fill />
          </div>

          <div className="mb-6 flex justify-center">
            <img
              src="/images/specchef-logo2.png"
              alt="SpecChef logo"
              className="h-24 w-auto"
            />
          </div>

          <motion.div
            variants={{ hidden: { opacity: 0, y: -20 }, visible: { opacity: 1, y: 0 } }}
            initial="hidden"
            whileInView="visible"
            transition={{ duration: 1, delay: 0.1 }}
            viewport={{ once: true }}
            className="animate_top mx-auto max-w-[500px] rounded-lg bg-white px-7.5 pt-7.5 pb-12.5 shadow-solid-8 dark:border dark:border-strokedark dark:bg-black xl:px-15 xl:pt-15"
          >
            <h2 className="mb-4 text-center text-3xl font-semibold text-black dark:text-white xl:text-sectiontitle2">
              Nouveau mot de passe
            </h2>
            <p className="mb-10 text-center text-base text-waterloo dark:text-manatee">
              Choisissez un nouveau mot de passe pour{" "}
              <span className="font-semibold text-black dark:text-white">{email}</span>.
              <br />
              Au moins 8 caractères, avec majuscule, minuscule et chiffre ou symbole.
            </p>

            <form onSubmit={handleSubmit}>
              <div className="mb-2 flex flex-col gap-2">
                <label
                  htmlFor="new-password"
                  className="text-sm font-medium text-black dark:text-white"
                >
                  Nouveau mot de passe
                </label>
                <div className="relative">
                  <input
                    id="new-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Nouveau mot de passe"
                    name="password"
                    required
                    minLength={8}
                    maxLength={32}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-transparent bg-gray-100 px-4 py-3 pr-20 text-black outline-hidden transition-colors focus:border-primary focus:bg-white dark:bg-[#2C303B] dark:text-white dark:focus:border-manatee dark:focus:bg-black"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium text-waterloo hover:text-primary dark:text-manatee"
                  >
                    {showPassword ? "Masquer" : "Afficher"}
                  </button>
                </div>

                <div className="mb-5 mt-1 flex flex-wrap gap-2">
                  {[
                    {
                      label: "Minimum 8 caractères",
                      valid: password.length >= 8,
                    },
                    {
                      label: "1 majuscule",
                      valid: /[A-Z]/.test(password),
                    },
                    {
                      label: "Au moins 1 caractère spécial",
                      valid: /[^A-Za-z0-9]/.test(password),
                    },
                  ].map((check) => (
                    <span
                      key={check.label}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                        check.valid
                          ? "bg-green-50 text-green-600 dark:bg-green-500/10 dark:text-green-400"
                          : "bg-gray-100 text-waterloo dark:bg-[#2C303B] dark:text-manatee"
                      }`}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          d="M20 6L9 17L4 12"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {check.label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mb-7.5 flex flex-col gap-2">
                <label
                  htmlFor="confirm-password"
                  className="text-sm font-medium text-black dark:text-white"
                >
                  Confirmer le mot de passe
                </label>
                <div className="relative">
                  <input
                    id="confirm-password"
                    type={showConfirmPassword ? "text" : "password"}
                    placeholder="Confirmer le mot de passe"
                    name="confirmPassword"
                    required
                    minLength={8}
                    maxLength={32}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full rounded-xl border border-transparent bg-gray-100 px-4 py-3 pr-20 text-black outline-hidden transition-colors focus:border-primary focus:bg-white dark:bg-[#2C303B] dark:text-white dark:focus:border-manatee dark:focus:bg-black"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium text-waterloo hover:text-primary dark:text-manatee"
                  >
                    {showConfirmPassword ? "Masquer" : "Afficher"}
                  </button>
                </div>
              </div>

              {error && (
                <div className="mb-7.5 rounded-lg border border-red-600/40 bg-red-600/5 px-4 py-3 text-sm text-red-700 dark:border-red-700/40 dark:bg-red-600/10 dark:text-red-400">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="mb-6 inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-black px-6 py-3 font-medium text-white duration-300 ease-in-out hover:bg-blackho disabled:cursor-not-allowed disabled:opacity-60 dark:bg-btndark dark:hover:bg-blackho"
              >
                {loading ? "Réinitialisation..." : "Réinitialiser le mot de passe"}
              </button>

              <div className="text-center">
                <Link className="text-black hover:text-primary dark:text-white dark:hover:text-primary" href="/auth/signin">
                  ← Retour à la connexion
                </Link>
              </div>
            </form>
          </motion.div>
        </div>
      </section>
    </>
  );
};

const ResetPassword = () => (
  <Suspense fallback={null}>
    <ResetPasswordForm />
  </Suspense>
);

export default ResetPassword;