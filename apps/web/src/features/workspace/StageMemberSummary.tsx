import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { components } from "@comiku/api-client";
import { Avatar } from "../../components/Avatar";
import { MemberAvatar } from "../account/MemberAvatar";
import { workPageAssignments } from "./page-workflow";
import { stageSummaryMembers } from "./stage-members";
import "./stage-member-summary.css";

type Work = components["schemas"]["WorkDetailDto"];
type Participant = Work["participants"][number];
type Stage = "translate" | "proofread" | "typeset";
const stageNames = { translate: "翻译", proofread: "校对", typeset: "嵌字" };

type SummaryMember = {
  userId: string;
  displayName: string;
  avatarVersion?: string | null;
  participant?: Participant;
  pageCount: number;
};

function SummaryAvatar({ member }: { member: SummaryMember }) {
  return member.avatarVersion ? (
    <MemberAvatar
      member={{
        id: member.userId,
        displayName: member.displayName,
        avatarVersion: member.avatarVersion,
      }}
      size="sm"
    />
  ) : (
    <Avatar name={member.displayName} size="sm" />
  );
}

export function StageMemberSummary({
  work,
  stage,
  emptyText = "暂无成员认领",
}: {
  work: Work;
  stage: Stage;
  emptyText?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rosterRef = useRef<HTMLDivElement>(null);
  const hoverClose = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const rosterId = useId();
  const assignments = workPageAssignments(work).filter(
    (page) => page.stage === stage,
  );
  const pageCount = new Map<string, number>();
  for (const page of assignments) {
    if (page.userId)
      pageCount.set(page.userId, (pageCount.get(page.userId) ?? 0) + 1);
  }
  const members: SummaryMember[] = stageSummaryMembers(work, stage).map(
    (participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      avatarVersion: participant.avatarVersion,
      participant,
      pageCount: pageCount.get(participant.userId) ?? 0,
    }),
  );
  const known = new Set(members.map((member) => member.userId));
  for (const [userId, count] of pageCount) {
    if (!known.has(userId))
      members.push({ userId, displayName: "已认领成员", pageCount: count });
  }
  const label = `${stageNames[stage]}参与成员`;
  const compact = members.length > 2;
  const visible = members.slice(0, compact ? 3 : 2);

  const cancelHoverClose = useCallback(() => {
    if (hoverClose.current) clearTimeout(hoverClose.current);
    hoverClose.current = null;
  }, []);
  const close = useCallback(
    (restoreFocus = false) => {
      cancelHoverClose();
      pinned.current = false;
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [cancelHoverClose],
  );

  useEffect(() => {
    close();
    return cancelHoverClose;
  }, [work.id, stage, close, cancelHoverClose]);

  // Use the same native top-layer popover pattern as SelectControl, so card
  // overflow and neighbouring stage stacking contexts cannot clip the roster.
  useLayoutEffect(() => {
    const roster = rosterRef.current;
    if (!open || !roster) return;
    function position() {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger || !roster) return;
      const below = window.innerHeight - trigger.bottom - 12;
      const above = trigger.top - 12;
      const upwards = below < 180 && above > below;
      roster.style.maxHeight = `${Math.max(40, Math.min(320, upwards ? above : below))}px`;
      const bounds = roster.getBoundingClientRect();
      roster.style.left = `${Math.max(8, Math.min(trigger.left, window.innerWidth - bounds.width - 8))}px`;
      roster.style.top = `${upwards ? Math.max(8, trigger.top - bounds.height - 4) : trigger.bottom + 4}px`;
    }
    const native = typeof roster.showPopover === "function";
    if (native) {
      roster.setAttribute("popover", "manual");
      roster.showPopover();
    }
    position();
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
      if (native && roster.matches(":popover-open")) roster.hidePopover();
    };
  }, [open, members.length]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, close]);

  if (!members.length)
    return <span className="stage-member-summary__empty">{emptyText}</span>;
  return (
    <div
      ref={rootRef}
      className="stage-member-summary"
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        cancelHoverClose();
        setOpen(true);
      }}
      onPointerLeave={() => {
        if (!pinned.current)
          hoverClose.current = setTimeout(() => setOpen(false), 120);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={triggerRef}
        className="stage-member-summary__trigger"
        type="button"
        aria-label={`${label}，${members.length} 人，查看完整名单`}
        aria-expanded={open}
        aria-controls={open ? rosterId : undefined}
        onClick={() => {
          cancelHoverClose();
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            pinned.current = true;
            setOpen(true);
          }
        }}
      >
        <span
          className={`stage-member-summary__preview${compact ? " is-compact" : ""}`}
          aria-hidden="true"
        >
          {visible.map((member) => (
            <span className="stage-member-summary__person" key={member.userId}>
              <SummaryAvatar member={member} />
              {!compact && (
                <span className="stage-member-summary__name">
                  {member.displayName}
                </span>
              )}
            </span>
          ))}
          {members.length > visible.length && (
            <span className="stage-member-summary__remainder">
              +{members.length - visible.length}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div
          ref={rosterRef}
          id={rosterId}
          role="region"
          aria-label={label}
          className="stage-member-summary__roster"
          tabIndex={0}
          onFocus={() => {
            pinned.current = true;
            cancelHoverClose();
          }}
        >
          <strong className="stage-member-summary__heading">
            {label}
            <span>{members.length} 人</span>
          </strong>
          <ul>
            {members.map((member) => {
              const person = member.participant;
              return (
                <li key={member.userId}>
                  <SummaryAvatar member={member} />
                  <span className="stage-member-summary__details">
                    <strong>{member.displayName}</strong>
                    <small>
                      {person
                        ? person.submittedAt
                          ? "已完成"
                          : person.contributionCurrent
                            ? "已完成分工"
                            : person.participationMode === "owner"
                              ? "负责人"
                              : "协作者"
                        : "成员资料暂不可用"}
                      {stage !== "proofread" && member.pageCount > 0
                        ? ` · 已认领 ${member.pageCount} 页`
                        : ""}
                    </small>
                    {person?.submittedAt && (
                      <small>
                        提交时署名：
                        {person.creditNameSnapshot ?? person.displayName}
                      </small>
                    )}
                    {!person?.submittedAt && person?.workCreditName && (
                      <small>临时署名：{person.workCreditName}</small>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
