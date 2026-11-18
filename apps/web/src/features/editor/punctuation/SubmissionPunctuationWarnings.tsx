import { useState } from "react";
import { Button } from "../../../components/ui";
import type { PunctuationResult } from "./check-punctuation";
import "./submission-punctuation-warnings.css";

const pageSize = 20;

export function SubmissionPunctuationWarnings({
  results,
}: {
  results: readonly PunctuationResult[];
}) {
  const [limit, setLimit] = useState(pageSize);
  return (
    <section className="submission-punctuation-warnings">
      <p>当前译文有 {results.length} 项标点提示，可确认提交。</p>
      <div tabIndex={0} role="region" aria-label="标点问题明细">
        <ol>
          {results.slice(0, limit).map((result) => {
            const from = Math.max(0, result.start - 16);
            const highlightEnd = Math.min(result.end, result.start + 40);
            const to = Math.min(result.text.length, result.end + 16);
            return (
              <li
                key={`${result.imageNumber}:${result.entryNumber}:${result.start}:${result.ruleId}`}
              >
                <strong>
                  第 {result.imageNumber} 页 · 标记 {result.entryNumber}
                </strong>
                <blockquote>
                  {from > 0 && "…"}
                  {result.text.slice(from, result.start)}
                  <mark>
                    {result.text.slice(result.start, highlightEnd)}
                    {highlightEnd < result.end && "…"}
                  </mark>
                  {result.text.slice(result.end, to)}
                  {to < result.text.length && "…"}
                </blockquote>
                <p>{result.explanation}</p>
              </li>
            );
          })}
        </ol>
        {results.length > limit && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setLimit((value) => value + pageSize)}
          >
            再显示 {Math.min(pageSize, results.length - limit)} 项
          </Button>
        )}
      </div>
    </section>
  );
}
