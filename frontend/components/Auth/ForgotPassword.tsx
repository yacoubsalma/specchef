"use client";
import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

const ForgotPassword = () => {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        setError(result?.message || "Utilisateur introuvable");
        setLoading(false);
        return;
      }
      router.push(`/auth/verify-otp?type=reset&email=${encodeURIComponent(email)}`);
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
              Mot de passe oublié
            </h2>
            <p className="mb-10 text-center text-base text-waterloo dark:text-manatee">
              Indiquez votre email — un code de réinitialisation à 6 chiffres vous sera envoyé.
            </p>

            <form onSubmit={handleSubmit}>
              <input
                type="email"
                placeholder="Email"
                name="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mb-7.5 w-full border-b border-stroke bg-white! pb-3.5 focus:border-waterloo focus:placeholder:text-black focus-visible:outline-hidden dark:border-strokedark dark:bg-black! dark:focus:border-manatee dark:focus:placeholder:text-white"
              />

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
                {loading ? "Envoi..." : "Envoyer le code"}
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

export default ForgotPassword;