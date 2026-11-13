import type { components } from "@comiku/api-client";
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Avatar } from "../../components/Avatar";
import { Button, IconButton, SearchField } from "../../components/ui";
import { client, unwrap } from "../account/api";
import { useBirthdayQuery } from "./use-birthday-query";
import "./birthdays.css";

type Person = components["schemas"]["BirthdayPersonDto"];
function birthdayDate(person: Person) {
  return person.month !== null && person.day !== null
    ? `${person.month} 月 ${person.day} 日`
    : "生日未知";
}
function PersonRow({ person }: { person: Person }) {
  return (
    <div
      className={`birthday-person ${person.daysUntil === 0 ? "is-today" : ""}`}
    >
      <Avatar
        name={person.name}
        src={person.avatarUrl ?? undefined}
        loading="lazy"
      />
      <span className="birthday-person-copy">
        <strong>{person.name}</strong>
        <span>
          {person.daysUntil === 0 ? "今天 · " : ""}
          {birthdayDate(person)}
        </span>
      </span>
    </div>
  );
}

export function BirthdayStrip({ enabled = true }: { enabled?: boolean }) {
  const summary = useBirthdayQuery("summary", enabled, async (signal) =>
    unwrap(await client.GET("/api/birthdays/summary", { signal })),
  );
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (!summary.data?.enabled || !summary.data.people.length) return null;
  return (
    <>
      <section className="birthday-strip" aria-label="角色生日">
        <h2>角色生日</h2>
        <div
          className="birthday-rail"
          role="region"
          aria-label="近期生日，可左右滚动"
          tabIndex={0}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const rail = event.currentTarget;
            const left =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rail.scrollWidth - rail.clientWidth
                  : rail.scrollLeft +
                    (event.key === "ArrowRight" ? 1 : -1) *
                      Math.max(120, rail.clientWidth * 0.7);
            rail.scrollTo({
              left,
              behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
                .matches
                ? "auto"
                : "smooth",
            });
          }}
        >
          {summary.data.people.map((person) => (
            <PersonRow key={person.key} person={person} />
          ))}
        </div>
        <button
          type="button"
          className="birthday-all"
          ref={opener}
          onClick={() => setOpen(true)}
        >
          全部生日
        </button>
      </section>
      {open && (
        <BirthdayCalendar
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
}

export function BirthdayCalendar({ onClose }: { onClose: () => void }) {
  const query = useBirthdayQuery("calendar", true, async (signal) =>
    unwrap(await client.GET("/api/birthdays/calendar", { signal })),
  );
  const [search, setSearch] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    // SearchField owns the input; focus it after the native dialog enters the top layer.
    (
      element.querySelector('input[type="search"]') as HTMLInputElement | null
    )?.focus();
    return () => {
      if (element.close) element.close();
      else element.removeAttribute("open");
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const needle = search.trim().toLocaleLowerCase();
  const people = (query.data?.people ?? []).filter((person) =>
    [person.name, ...person.aliases].some((name) =>
      name.toLocaleLowerCase().includes(needle),
    ),
  );
  const known = people
    .filter((person) => person.month !== null && person.day !== null)
    .sort(
      (a, b) =>
        (a.daysUntil ?? Infinity) - (b.daysUntil ?? Infinity) ||
        a.key.localeCompare(b.key),
    );
  const unknown = people.filter(
    (person) => person.month === null || person.day === null,
  );
  return (
    <dialog
      ref={dialog}
      className="birthday-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          ),
        );
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header className="birthday-panel-heading">
        <h2 id={titleId}>全部生日</h2>
        <IconButton label="关闭生日一览" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <SearchField
        type="search"
        label="搜索角色"
        placeholder="中文、日文或别名"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {query.isPending && <p role="status">正在读取生日…</p>}
      {query.isError && (
        <div>
          <p role="alert">生日列表读取失败。</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </div>
      )}
      <div className="birthday-calendar-list">
        {known.map((person) => (
          <PersonRow key={person.key} person={person} />
        ))}
        {unknown.length > 0 && (
          <section className="birthday-unknown">
            <h3>生日未知</h3>
            {unknown.map((person) => (
              <PersonRow key={person.key} person={person} />
            ))}
          </section>
        )}
        {query.data && people.length === 0 && <p>没有匹配的角色。</p>}
      </div>
      <footer className="birthday-calendar-footer">
        {query.data?.timezone ?? "Asia/Shanghai"}
      </footer>
    </dialog>
  );
}
