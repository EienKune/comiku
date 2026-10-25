export const defaultPublicationTemplateKey = "default";

export interface PublicationTemplateValues {
  proofreadingSkipped?: boolean;
  title: string;
  body: string | null;
  author: string;
  translationCredits: string[];
  proofreadCredits: string[];
  typesetCredits: string[];
}

export function normalizeAuthorCredit(
  handle: string | null | undefined,
  displayName: string,
) {
  const normalizedHandle = handle?.trim().replace(/^@+/, "");
  return normalizedHandle ? `@${normalizedHandle}` : displayName.trim();
}

export function renderPublicationText(
  template: string,
  values: PublicationTemplateValues,
) {
  const body = values.body?.trim();
  // Remove only the template's dedicated credit row, before user text is inserted.
  const effectiveTemplate = values.proofreadingSkipped
    ? template
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "校对：{{proofread_credits}}")
        .join("\n")
    : template;
  const replacements: Record<string, string> = {
    "{{title}}": values.title.trim(),
    "{{body}}": body ? `${body}\n` : "",
    "{{author}}": values.author,
    "{{translation_credits}}": values.translationCredits.join("、"),
    "{{proofread_credits}}": values.proofreadCredits.join("、"),
    "{{typeset_credits}}": values.typesetCredits.join("、"),
  };
  return Object.entries(replacements).reduce(
    (result, [token, value]) => result.replaceAll(token, value),
    effectiveTemplate,
  );
}
