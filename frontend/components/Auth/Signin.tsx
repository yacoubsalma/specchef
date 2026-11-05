"use client";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const SigninForm = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState({
    email: "",
    password: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const justActivated = searchParams.get("activated") === "1";
  const justReset = searchParams.get("reset") === "1";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.email, password: data.password }),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        const message: string = result?.message || "Identifiants invalides";
        if (message.toLowerCase().includes("non vérifié")) {
          router.push(`/auth/verify-otp?type=verify&email=${encodeURIComponent(data.email)}`);
          return;
        }
        setError(message);
        setLoading(false);
        return;
      }
      const next = searchParams.get("next") || "/dashboard";
      router.push(next);
      router.refresh();
    } catch {
      setError("Impossible de contacter le serveur.");
      setLoading(false);
    }
  };

  return (
    <>
      <section className="flex min-h-screen items-center justify-center bg-linear-to-b from-[#f4f7ff] to-white px-4 py-12.5 dark:from-[#0c0e1a] dark:to-black">
        <div className="relative z-1 mx-auto w-full max-w-[500px] px-4">
          <div className="absolute left-0 top-0 -z-1 h-2/3 w-full rounded-lg bg-linear-to-t from-transparent to-[#dee7ff47] dark:bg-linear-to-t dark:to-[#252A42]"></div>
          <div className="absolute bottom-17.5 left-0 -z-1 h-1/3 w-full">
            <Image
              src="/images/shape/shape-dotted-light.svg"
              alt="Dotted"
              className="dark:hidden"
              fill
            />
            <Image
              src="/images/shape/shape-dotted-dark.svg"
              alt="Dotted"
              className="hidden dark:block"
              fill
            />
          </div>

          <div className="mb-6 flex justify-center">
            <img
              src="/images/specchef-logo2.png"
              alt="SpecChef logo"
              className="h-24 w-auto"
            />
          </div>

          <motion.div
            variants={{
              hidden: {
                opacity: 0,
                y: -20,
              },

              visible: {
                opacity: 1,
                y: 0,
              },
            }}
            initial="hidden"
            animate="visible"
            transition={{ duration: 0.6, delay: 0.1 }}
            className="animate_top rounded-2xl bg-white px-7.5 pb-10 pt-10 shadow-solid-8 dark:border dark:border-strokedark dark:bg-black sm:px-12.5 sm:pt-12.5"
          >
            <div className="mb-10 text-center">
              <h2 className="mb-2 text-3xl font-semibold text-black dark:text-white">
                Connexion
              </h2>
              <p className="text-base text-waterloo dark:text-manatee">
                Accédez à votre espace SpecChef
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              {(justActivated || justReset) && (
                <div className="mb-7.5 rounded-lg border border-meta/40 bg-meta/5 px-4 py-3 text-sm text-meta">
                  {justActivated
                    ? "Compte activé avec succès — vous pouvez vous connecter."
                    : "Mot de passe réinitialisé avec succès — vous pouvez vous connecter."}
                </div>
              )}
              <div className="mb-7.5 flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="email"
                    className="text-sm font-medium text-black dark:text-white"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    placeholder="vous@exemple.com"
                    name="email"
                    required
                    autoComplete="email"
                    value={data.email}
                    onChange={(e) => setData({ ...data, email: e.target.value })}
                    className="w-full rounded-lg border border-stroke bg-white! px-4 py-3 text-black outline-hidden transition-colors focus:border-primary focus:placeholder:text-black dark:border-strokedark dark:bg-black! dark:text-white dark:focus:border-manatee dark:focus:placeholder:text-white"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="password"
                    className="text-sm font-medium text-black dark:text-white"
                  >
                    Mot de passe
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      name="password"
                      required
                      autoComplete="current-password"
                      value={data.password}
                      onChange={(e) =>
                        setData({ ...data, password: e.target.value })
                      }
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

                </div>
              </div>

              {error && (
                <div className="mb-7.5 rounded-lg border border-red-600/40 bg-red-600/5 px-4 py-3 text-sm text-red-700 dark:text-red-700 dark:text-red-400 dark:border-red-700/40 dark:bg-red-600/10 dark:text-red-700 dark:text-red-400">
                  {error}
                </div>
              )}

              <div className="mb-6 flex items-center justify-end text-sm">
                <Link
                  href="/auth/forgot-password"
                  className="text-waterloo hover:text-primary dark:text-manatee"
                >
                  Mot de passe oublié ?
                </Link>
              </div>

              <button
                type="submit"
                disabled={loading}
                aria-label="login with email and password"
                className="inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-black px-6 py-3 font-medium text-white duration-300 ease-in-out hover:bg-blackho disabled:cursor-not-allowed disabled:opacity-60 dark:bg-btndark dark:hover:bg-blackho"
              >
                {loading ? "Connexion..." : "Se connecter"}
                <svg
                  className="fill-white"
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M10.4767 6.16664L6.00668 1.69664L7.18501 0.518311L13.6667 6.99998L7.18501 13.4816L6.00668 12.3033L10.4767 7.83331H0.333344V6.16664H10.4767Z"
                    fill=""
                  />
                </svg>
              </button>

              <div className="mt-10 border-t border-stroke pt-6 text-center text-sm dark:border-strokedark">
                <p className="text-waterloo dark:text-manatee mb-2">
                  Pas de compte ? Les comptes sont créés par un administrateur.
                </p>
                <p className="text-waterloo dark:text-manatee">
                  Vous avez reçu un code d'activation par email ?{" "}
                  <Link
                    className="text-black hover:text-primary dark:text-white dark:hover:text-primary"
                    href="/auth/verify-otp?type=verify"
                  >
                    Activer mon compte
                  </Link>
                </p>
              </div>
            </form>
          </motion.div>
        </div>
      </section>
    </>
  );
};

const Signin = () => (
  <Suspense fallback={null}>
    <SigninForm />
  </Suspense>
);

export default Signin;