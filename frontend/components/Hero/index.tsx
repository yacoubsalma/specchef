"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

const Hero = () => {
  const [hovered, setHovered] = useState(false);

  return (
    <>
      <section className="overflow-hidden pb-20 pt-35 md:pt-40 xl:pb-25 xl:pt-46">
        <div className="mx-auto max-w-c-1390 px-4 md:px-8 2xl:px-0">
          <div className="flex lg:items-center lg:gap-8 xl:gap-32.5">
            <div className="md:w-1/2">
              <h4 className="mb-4.5 text-lg font-medium text-black dark:text-white">
                🧪 LLM-Powered QA Platform
              </h4>
              <h1 className="mb-5 pr-16 text-3xl font-bold text-black dark:text-white xl:text-hero">
                Générez vos{" "}
                <span className="relative inline-block before:absolute before:bottom-2.5 before:left-0 before:-z-1 before:h-3 before:w-full before:bg-titlebg dark:before:bg-titlebgdark">
                  Cahiers de Recettes
                </span>{" "}
                avec l'IA
              </h1>
              <p className="text-waterloo dark:text-manatee">
                Transformez vos documents d'exigences (PDF, DOCX, XLSX) en cas de test
                complets et structurés grâce aux Large Language Models. Validez, éditez
                et sauvegardez directement en base de données.
              </p>

              <div className="mt-10">
                <div className="flex flex-wrap gap-5">
                  <Link
                    href="/analyzer"
                    className="flex items-center gap-2.5 rounded-full bg-black px-7.5 py-2.5 text-white duration-300 ease-in-out hover:bg-blackho dark:bg-btndark dark:hover:bg-blackho"
                  >
                    <span>⚡ Analyser un document</span>
                  </Link>
                  <Link
                    href="/projects"
                    className="flex items-center gap-2.5 rounded-full border border-stroke px-7.5 py-2.5 text-black duration-300 ease-in-out hover:border-primary hover:text-primary dark:border-strokedark dark:text-white dark:hover:border-primary dark:hover:text-primary"
                  >
                    📂 Voir mes projets
                  </Link>
                </div>

                <div className="mt-7.5 flex flex-wrap gap-5">
                  {[
                    { icon: "✓", text: "9 types de cas de test" },
                    { icon: "✓", text: "AssistTest intégré" },
                    { icon: "✓", text: "Persistance PostgreSQL" },
                    { icon: "✓", text: "Vector Search SRS" },
                  ].map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-meta font-bold">{item.icon}</span>
                      <span className="text-sm text-waterloo dark:text-manatee">{item.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="animate_right hidden md:w-1/2 lg:block">
              <div className="relative 2xl:-mr-7.5">
                <Image
                  src="/images/shape/shape-01.png"
                  alt="shape"
                  width={46}
                  height={246}
                  className="absolute -left-11.5 top-0"
                />
                <Image
                  src="/images/shape/shape-02.svg"
                  alt="shape"
                  width={36.9}
                  height={36.7}
                  className="absolute bottom-0 right-0 z-10"
                />
                <Image
                  src="/images/shape/shape-03.svg"
                  alt="shape"
                  width={21.64}
                  height={21.66}
                  className="absolute -right-6.5 bottom-0 z-1"
                />
                {/* LLM Analyzer preview card */}
                <div className="relative aspect-700/444 w-full rounded-2xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection shadow-solid-l overflow-hidden">
                  {/* Header */}
                  <div className="h-12 bg-alabaster dark:bg-black/20 border-b border-stroke dark:border-strokedark flex items-center px-5 gap-3">
                    <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-white text-sm font-bold">📋</div>
                    <div>
                      <div className="text-xs font-bold text-black dark:text-white">Cahier de Recettes</div>
                      <div className="text-[9px] text-waterloo">EXIGENCES → CAS DE TEST → VALIDATION</div>
                    </div>
                    <div className="ml-auto flex items-center gap-1.5 text-[9px] font-bold text-meta">
                      <div className="w-1.5 h-1.5 rounded-full bg-meta animate-pulse" />
                      Backend OK
                    </div>
                  </div>
                  {/* Mock modules */}
                  <div className="p-4 space-y-2">
                    {[
                      { name: "Authentication Module", reqs: 4, tcs: 18, color: "text-primary bg-zumthor" },
                      { name: "User Management", reqs: 6, tcs: 24, color: "text-sky-700 bg-sky-50" },
                      { name: "API Gateway", reqs: 3, tcs: 12, color: "text-meta bg-meta/10" },
                    ].map((mod, i) => (
                      <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-black">
                        <span className={`text-[10px] font-bold px-2 py-1 rounded-lg flex-shrink-0 ${mod.color}`}>📦 {mod.reqs}</span>
                        <span className="text-xs font-semibold text-black dark:text-white flex-1 truncate">{mod.name}</span>
                        <span className="text-[9px] font-bold text-meta bg-meta/10 border border-meta/30 rounded px-2 py-0.5">{mod.tcs} TC</span>
                        <span className="text-[9px] font-bold text-meta">✓</span>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      {["✓ Positive", "✗ Négative", "◈ Edge", "⇔ Boundary"].map((t, i) => (
                        <span key={i} className="text-[8px] font-bold px-2 py-1 rounded border border-stroke dark:border-strokedark text-waterloo">{t}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
};

export default Hero;