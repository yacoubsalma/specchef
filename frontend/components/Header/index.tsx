"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import ThemeToggler from "./ThemeToggler";
import menuData from "./menuData";
import NotificationBell from "@/app/components/NotificationBell";

// ─── Liens du menu Admin — visible uniquement pour role === "ADMIN" ─────────
// Ajouter une entrée ici l'ajoute automatiquement au dropdown.
const ADMIN_LINKS = [
  { href: "/admin/users", label: "Utilisateurs", icon: "👥" },
   { href: "/admin/langfuse", label: "Pilotage IA", icon: "📊" },
     { href: "/admin/atlassian", label: "Accès Atlassian", icon: "🔗" },

];

const Header = () => {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [dropdownToggler, setDropdownToggler] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [stickyMenu, setStickyMenu] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ email?: string; name?: string; role?: string } | null>(null);
  const adminMenuRef = useRef<HTMLLIElement>(null);

  const pathUrl = usePathname();
  const router = useRouter();

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setCurrentUser(d?.user ?? null))
      .catch(() => setCurrentUser(null));
  }, [pathUrl]);

  // Ferme le dropdown Admin au clic en dehors, ou en changeant de page
  useEffect(() => {
    setAdminMenuOpen(false);
  }, [pathUrl]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (adminMenuRef.current && !adminMenuRef.current.contains(e.target as Node)) {
        setAdminMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setCurrentUser(null);
      router.push('/auth/signin');
    }
  };

  // Sticky menu
  const handleStickyMenu = () => {
    if (window.scrollY >= 80) {
      setStickyMenu(true);
    } else {
      setStickyMenu(false);
    }
  };

  useEffect(() => {
    window.addEventListener("scroll", handleStickyMenu);
  });

  return (
    <header
      className={`fixed left-0 top-0 z-[100] w-full py-7 ${stickyMenu
          ? "bg-white py-4! shadow-sm transition duration-100 dark:bg-black"
          : ""
        }`}
    >
      <div className="relative mx-auto max-w-c-1390 items-center justify-between px-4 md:px-8 xl:flex 2xl:px-0">
        <div className="flex w-full items-center justify-between xl:w-1/3">
          <a href="/" className="flex items-center gap-2">
            <img
              src="/images/specchef-logo2.png"
              alt="SpecChef logo"
              width={32}
              height={32}
                className="w-32 h-20 "


            />
          </a>

          <button
            aria-label="hamburger Toggler"
            className="block xl:hidden"
            onClick={() => setNavigationOpen(!navigationOpen)}
          >
            <span className="relative block h-5.5 w-5.5 cursor-pointer">
              <span className="absolute right-0 block h-full w-full">
                <span
                  className={`relative left-0 top-0 my-1 block h-0.5 rounded-sm bg-black delay-0 duration-200 ease-in-out dark:bg-white ${!navigationOpen ? "w-full! delay-300" : "w-0"
                    }`}
                ></span>
                <span
                  className={`relative left-0 top-0 my-1 block h-0.5 rounded-sm bg-black delay-150 duration-200 ease-in-out dark:bg-white ${!navigationOpen ? "delay-400 w-full!" : "w-0"
                    }`}
                ></span>
                <span
                  className={`relative left-0 top-0 my-1 block h-0.5 rounded-sm bg-black delay-200 duration-200 ease-in-out dark:bg-white ${!navigationOpen ? "w-full! delay-500" : "w-0"
                    }`}
                ></span>
              </span>
              <span className="du-block absolute right-0 h-full w-full rotate-45">
                <span
                  className={`absolute left-2.5 top-0 block h-full w-0.5 rounded-sm bg-black delay-300 duration-200 ease-in-out dark:bg-white ${!navigationOpen ? "h-0! delay-0" : "h-full"
                    }`}
                ></span>
                <span
                  className={`delay-400 absolute left-0 top-2.5 block h-0.5 w-full rounded-sm bg-black duration-200 ease-in-out dark:bg-white ${!navigationOpen ? "h-0! delay-200" : "h-0.5"
                    }`}
                ></span>
              </span>
            </span>
          </button>
        </div>

        {/* Nav Menu Start   */}
        <div
          className={`invisible h-0 w-full items-center justify-between xl:visible xl:flex xl:h-auto xl:w-full ${navigationOpen &&
            "navbar visible! mt-4 h-auto max-h-[400px] rounded-md bg-white p-7.5 shadow-solid-5 dark:bg-blacksection xl:h-auto xl:p-0 xl:shadow-none xl:dark:bg-transparent"
            }`}
        >
          <nav>
            <ul className="flex flex-col gap-5 xl:flex-row xl:items-center xl:gap-10">
              {currentUser?.role && (
                <li>
                  <Link
                    href="/dashboard"
                    className={pathUrl === "/dashboard" ? "text-primary hover:text-primary" : "hover:text-primary"}
                  >
                    Suivi & visualisation
                  </Link>
                </li>
              )}

              {currentUser?.role === "PO" && (
                <li>
                  <Link
                    href="/campaigns"
                    className={pathUrl.startsWith("/campaigns") ? "text-primary hover:text-primary" : "hover:text-primary"}
                  >
                    Campagnes
                  </Link>
                </li>
              )}

              {menuData.map((menuItem, key) => (
                <li key={key} className={menuItem.submenu && "group relative"}>
                  {menuItem.submenu ? (
                    <>
                      <button
                        onClick={() => setDropdownToggler(!dropdownToggler)}
                        className="flex cursor-pointer items-center justify-between gap-3 hover:text-primary"
                      >
                        {menuItem.title}
                        <span>
                          <svg
                            className="h-3 w-3 cursor-pointer fill-waterloo group-hover:fill-primary"
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 512 512"
                          >
                            <path d="M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z" />
                          </svg>
                        </span>
                      </button>

                      <ul
                        className={`dropdown ${dropdownToggler ? "flex" : ""}`}
                      >
                        {menuItem.submenu.map((item, key) => (
                          <li key={key} className="hover:text-primary">
                            <Link href={item.path || "#"}>{item.title}</Link>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <Link
                      href={`${menuItem.path}`}
                      className={
                        pathUrl === menuItem.path
                          ? "text-primary hover:text-primary"
                          : "hover:text-primary"
                      }
                    >
                      {menuItem.title}
                    </Link>
                  )}
                </li>
              ))}

              {currentUser?.role === "ADMIN" && (
                <li className="group relative" ref={adminMenuRef}>
                  <button
                    onClick={() => setAdminMenuOpen(!adminMenuOpen)}
                    className="flex cursor-pointer items-center justify-between gap-3 hover:text-primary"
                  >
                    Administration
                    <span>
                      <svg
                        className="h-3 w-3 cursor-pointer fill-waterloo group-hover:fill-primary"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 512 512"
                      >
                        <path d="M233.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L256 338.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z" />
                      </svg>
                    </span>
                  </button>

                  <ul className={`dropdown ${adminMenuOpen ? "flex" : ""}`}>
                    {ADMIN_LINKS.map((item) => (
                      <li key={item.href} className="hover:text-primary">
                        <Link href={item.href} onClick={() => setAdminMenuOpen(false)}>
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              )}
            </ul>
          </nav>

          <div className="mt-7 flex items-center gap-6 xl:mt-0">
            <ThemeToggler />
            {currentUser && (
              <div className="flex items-center gap-2 xl:border-l xl:border-stroke xl:pl-6 xl:dark:border-strokedark">
                <NotificationBell />
                <Link href="/account" className="text-sm font-bold text-black hover:text-primary dark:text-white">
                  {currentUser.name || currentUser.email}
                  {currentUser.role && <span className="font-medium text-waterloo dark:text-manatee"> · {currentUser.role}</span>}
                </Link>
                <button
                  onClick={handleLogout}
                  className="rounded-full border border-stroke bg-alabaster px-3 py-1 text-xs font-bold text-waterloo hover:border-red-600/30 hover:text-red-700 dark:border-strokedark dark:bg-blacksection dark:hover:text-red-400"
                >
                  Déconnexion
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

// w-full delay-300

export default Header;