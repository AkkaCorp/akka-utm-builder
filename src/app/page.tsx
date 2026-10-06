import Image from "next/image";
import { AccountChip } from "@akka/auth/login-screen";
import { requireUser } from "@akka/auth/server";
import { UtmBuilder } from "./utm-builder";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { email } = await requireUser();
  const shortDomain = process.env.SHORTIO_DOMAIN || "go.akka.app";

  return (
    <>
      <header className="top">
        <div className="wrap row">
          <div className="brand">
            <Image src="/akka-logo.png" alt="Akka" width={67} height={22} priority />
            <span className="brand-sep" aria-hidden="true" />
            <span className="brand-name">UTM Link Builder</span>
          </div>
          <AccountChip email={email} />
        </div>
      </header>

      <main className="wrap">
        <section className="masthead">
          <h1>Build a tracking link</h1>
          <p className="sub">
            Pick a market, a landing page and who is sharing it, and get a clean akka.app link back.
            No UTM syntax required.
          </p>
        </section>
        <UtmBuilder shortDomain={shortDomain} />
      </main>
    </>
  );
}
