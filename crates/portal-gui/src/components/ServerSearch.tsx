import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { usePortal } from "../context";
import { openSidebar } from "../dock/dock";

// 🔍 sunucu arama popover'ı: host'ları filtreler; seçince odaklar. (İleri/geri yok.)
export function ServerSearch() {
  const { hosts, selectHost } = usePortal();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? hosts.filter((h) => `${h.label} ${h.address} ${h.username ?? ""}`.toLowerCase().includes(s))
      : hosts;
    return list.slice(0, 20);
  }, [hosts, q]);

  const pick = (id: string) => {
    selectHost(id);
    openSidebar();
    setOpen(false);
    setQ("");
  };

  return (
    <div className="dd-wrap" ref={ref}>
      <button
        className={"tb-search lit" + (open ? " on" : "")}
        title="Search servers"
        aria-label="Search servers"
        onClick={() => setOpen((o) => !o)}
      >
        <Search size={16} strokeWidth={1.75} />
        <span className="ph">Find a host…</span>
      </button>
      {open && (
        <div className="search-pop">
          <div className="sin">
            <Search size={16} strokeWidth={1.75} />
            <input
              ref={inputRef}
              placeholder="Search servers…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="sres">
            {results.length === 0 ? (
              <div className="sempty">
                {hosts.length === 0 ? "No servers yet — add one from the Hosts panel." : "No match."}
              </div>
            ) : (
              results.map((h) => (
                <button className="sr" key={h.id} onClick={() => pick(h.id)}>
                  <span className="dot on" />
                  <span className="nm">{h.label}</span>
                  <span className="ip mono">{h.address}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
