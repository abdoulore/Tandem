import { Link, NavLink, Outlet } from "react-router-dom";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Lightning, Pulse } from "@phosphor-icons/react";
import { useAppData } from "../state/AppData";
import { BrandMark } from "./Brand";

const SOURCE_SHORT = { pyth: "Pyth", prestocks: "PreStocks", finnhub: "Finnhub", jupiter: "Jupiter" } as const;
const SOURCE_LONG = { pyth: "Pyth", prestocks: "PreStocks", finnhub: "Finnhub, checked against Backed", jupiter: "Backed via Jupiter (paper mode)" } as const;
const ORDER = ["pyth", "finnhub", "prestocks", "jupiter"] as const;

export function AppShell() {
  const { status, readyCount } = useAppData();
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Tandem home">
          <BrandMark />
          Tandem
        </Link>
        <nav className="appnav" aria-label="App">
          <NavLink to="/app" end>
            New order
          </NavLink>
          <NavLink to="/app/orders">
            My orders
            {readyCount > 0 && (
              <span className="count" aria-label={`${readyCount} ready to confirm`}>
                {readyCount}
              </span>
            )}
          </NavLink>
          <NavLink to="/app/markets">Markets</NavLink>
        </nav>
        <div className="spacer" />
        {status && (
          <span
            className="chip hide-md"
            title={[
              ...ORDER.filter((k) => status.coverage[k]?.length).map((k) => `${SOURCE_LONG[k]}: ${status.coverage[k]!.join(", ")}`),
              status.sourceNote,
            ].join("\n")}
          >
            <Pulse size={14} weight="bold" />
            Prices:{" "}
            {ORDER.filter((k) => status.coverage[k]?.length)
              .map((k) => SOURCE_SHORT[k])
              .join(" · ")}
          </span>
        )}
        {status && (
          <span
            className={`chip hide-md ${status.liveEnabled ? (status.autoEnabled ? "good" : "warn") : ""}`}
            title={status.autoEnabled ? "Keeper ready for automatic switches" : `Automatic switching unavailable: ${status.liveBlockers.join(", ")}`}
          >
            <Lightning size={14} weight="bold" />
            {!status.liveEnabled ? "Paper mode" : status.autoEnabled ? "Live switching on" : "Live: one-tap only"}
          </span>
        )}
        <WalletMultiButton />
      </header>
      <Outlet />
    </>
  );
}
