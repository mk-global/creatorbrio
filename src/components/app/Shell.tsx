"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { Clapperboard, House, LayoutGrid, LayoutTemplate, Palette, PanelLeftClose, PanelLeftOpen, Plus, Settings } from "lucide-react";
import { BrandSwitcher } from "./BrandSwitcher";
import { Logo } from "./Logo";

/**
 * The app shell (#175, Design C). A sidebar from 768 px up, a header and a
 * five-tab bar on phones; each destination appears once in whatever
 * navigation is visible. The sidebar is a 76 px rail below 1280 px and in
 * the editor, unless the person expands it; the choice is remembered
 * separately for the editor.
 *
 * Two layouts. Pages scroll the document inside a padded column. The editor
 * and the Video Studio are workspaces: the column is exactly the window's
 * height and the page fills it, so their panels scroll on their own.
 */

const NAV = [
  { href: "/", label: "Home", short: "Home", icon: House },
  { href: "/projects", label: "Projects", short: "Projects", icon: LayoutGrid },
  { href: "/templates", label: "Templates", short: "Templates", icon: LayoutTemplate },
  { href: "/brands", label: "Brands", short: "Brands", icon: Palette },
  { href: "/studio", label: "Video Studio", short: "Studio", icon: Clapperboard },
] as const;

type SidePref = "auto" | "expanded" | "collapsed";
const KEY_PAGES = "creatorbrio:sidebar";
const KEY_EDITOR = "creatorbrio:sidebar-editor";
const PREF_EVENT = "creatorbrio:sidebar-change";

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/projects" && pathname.startsWith("/carousel/")) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

// The remembered sidebar choice is an external store: the server and the
// first client render use the default, then the stored choice applies.
function readPref(key: string): SidePref | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === "expanded" || v === "collapsed" ? v : null;
  } catch {
    return null;
  }
}

function writePref(key: string, value: SidePref) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage may be unavailable; the choice then lasts for this page only
  }
  window.dispatchEvent(new Event(PREF_EVENT));
}

function subscribePref(onChange: () => void) {
  window.addEventListener(PREF_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREF_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function useSidePref(key: string, fallback: SidePref): SidePref {
  return useSyncExternalStore(subscribePref, () => readPref(key) ?? fallback, () => fallback);
}

function NavItem({ href, label, short, icon: Icon, active }: (typeof NAV)[number] & { active: boolean }) {
  const early = href === "/studio";
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        aria-label={early ? `${label}, early` : undefined}
        className={`side-item ${active ? "side-item-active" : ""}`}
      >
        <Icon className="size-[19px] shrink-0" strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
        <span className="wide-only min-w-0 flex-1 truncate">{label}</span>
        <span className="rail-only text-[11px] leading-tight">{short}</span>
        {early && <span className="tag tag-early wide-only">Early</span>}
        {early && (
          <span className="rail-only rounded-full bg-early-bg px-1.5 text-[10.5px] leading-[16px] font-semibold text-early">Early</span>
        )}
      </Link>
    </li>
  );
}

function Sidebar({ pathname, onToggle }: { pathname: string; onToggle: () => void }) {
  const router = useRouter();
  const settingsActive = pathname === "/settings";
  return (
    <aside aria-label="Sidebar" className="side sticky top-0 hidden h-dvh flex-col border-r border-rule md:flex">
      <div className="flex items-center gap-2 px-3 pt-4 pb-3">
        <Link href="/" className="wide-only flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1" aria-label="CreatorBrio home">
          <Logo />
          <span className="display-md text-[19px]">CreatorBrio</span>
        </Link>
        <Link href="/" className="rail-only mx-auto rounded-md p-1" aria-label="CreatorBrio home">
          <Logo />
        </Link>
        <button
          type="button"
          onClick={onToggle}
          className="wide-only btn btn-ghost btn-sm btn-icon shrink-0 text-graphite"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <PanelLeftClose className="size-[18px]" aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="rail-only btn btn-ghost btn-sm btn-icon mx-auto mb-2 text-graphite"
        aria-label="Expand sidebar"
        title="Expand sidebar"
      >
        <PanelLeftOpen className="size-[18px]" aria-hidden="true" />
      </button>

      <div className="space-y-2 px-3">
        <BrandSwitcher variant="side" />
        <button type="button" className="btn btn-primary wide-only w-full" onClick={() => router.push("/create")}>
          <Plus className="size-[18px]" aria-hidden="true" />
          New project
        </button>
        <button
          type="button"
          className="btn btn-primary btn-icon rail-only mx-auto"
          onClick={() => router.push("/create")}
          aria-label="New project"
          title="New project"
        >
          <Plus className="size-[18px]" aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Main" className="mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
        <ul className="space-y-0.5">
          {NAV.map((n) => (
            <NavItem key={n.href} {...n} active={isActive(pathname, n.href)} />
          ))}
        </ul>
        <ul className="mt-auto space-y-0.5 border-t border-rule pt-3">
          <li>
            <Link
              href="/settings"
              aria-current={settingsActive ? "page" : undefined}
              className={`side-item ${settingsActive ? "side-item-active" : ""}`}
            >
              <Settings className="size-[19px] shrink-0" strokeWidth={settingsActive ? 2.2 : 1.8} aria-hidden="true" />
              <span className="wide-only flex-1">Settings</span>
              <span className="rail-only text-[11px] leading-tight">Settings</span>
            </Link>
          </li>
        </ul>
        <p className="wide-only mt-3 px-2.5 text-[12.5px] leading-snug text-graphite">Your work is saved as files on this computer.</p>
      </nav>
    </aside>
  );
}

function PhoneHeader({ pathname }: { pathname: string }) {
  const router = useRouter();
  const onSettings = pathname === "/settings";
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-ground/92 backdrop-blur-md md:hidden">
      <div className="flex h-14 items-center gap-1.5 px-3">
        <Link href="/" className="shrink-0 rounded-md p-1" aria-label="CreatorBrio home">
          <Logo size={28} />
        </Link>
        <div className="min-w-0 flex-1">
          <BrandSwitcher variant="header" />
        </div>
        <button type="button" className="btn btn-primary btn-icon shrink-0" onClick={() => router.push("/create")} aria-label="New project">
          <Plus className="size-[18px]" aria-hidden="true" />
        </button>
        <Link
          href="/settings"
          aria-current={onSettings ? "page" : undefined}
          className={`btn btn-ghost btn-icon shrink-0 ${onSettings ? "bg-hover" : ""}`}
          aria-label="Settings"
        >
          <Settings className="size-[18px]" aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}

function TabBar({ pathname, fixed }: { pathname: string; fixed: boolean }) {
  return (
    <nav
      aria-label="Main"
      className={`${fixed ? "fixed inset-x-0 bottom-0 z-40" : "shrink-0"} border-t border-rule bg-sheet/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden`}
    >
      <ul className="grid grid-cols-5">
        {NAV.map((n) => {
          const active = isActive(pathname, n.href);
          const Icon = n.icon;
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={active ? "page" : undefined}
                aria-label={n.href === "/studio" ? "Video Studio, early" : undefined}
                className={`relative flex h-16 flex-col items-center justify-center gap-1 text-[11.5px] font-medium ${active ? "text-ink" : "text-graphite"}`}
              >
                <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
                {n.short}
                {active && <span className="absolute top-0 h-[2px] w-8 bg-ink" aria-hidden="true" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const editor = pathname.startsWith("/carousel/");
  const studio = pathname === "/studio" || pathname.startsWith("/studio/");
  const workspace = editor || studio;
  const key = editor ? KEY_EDITOR : KEY_PAGES;
  const pref = useSidePref(key, editor ? "collapsed" : "auto");

  const toggle = () => {
    // "auto" is expanded only at 1280 px and wider, so read what is on screen.
    const wide = pref === "expanded" || (pref === "auto" && window.matchMedia("(min-width: 80rem)").matches);
    writePref(key, wide ? "collapsed" : "expanded");
  };

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:rounded-md focus:bg-sheet focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <div className="app md:grid" data-side={pref}>
        <Sidebar pathname={pathname} onToggle={toggle} />
        {workspace ? (
          <div className="flex h-dvh min-w-0 flex-col">
            {studio && <PhoneHeader pathname={pathname} />}
            <main id="main" className="flex min-h-0 flex-1 flex-col">
              {children}
            </main>
            {studio && <TabBar pathname={pathname} fixed={false} />}
          </div>
        ) : (
          <div className="min-w-0">
            <PhoneHeader pathname={pathname} />
            <main id="main" className="mx-auto max-w-[1240px] px-4 pt-6 pb-28 sm:px-6 md:px-10 md:pt-10 md:pb-20 xl:px-12">
              {children}
            </main>
          </div>
        )}
      </div>
      {!workspace && <TabBar pathname={pathname} fixed />}
    </>
  );
}
