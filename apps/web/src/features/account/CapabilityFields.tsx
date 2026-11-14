import type { components } from "@comiku/api-client";

type Options = components["schemas"]["RegistrationOptionsDto"];
export type Capabilities = Pick<
  components["schemas"]["RegisterDto"],
  "roles" | "languageCapabilities"
>;

export function CapabilityFields({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: Options;
  value: Capabilities;
  onChange: (value: Capabilities) => void;
  disabled?: boolean;
}) {
  const roles = options.roles.flatMap(({ value, label }) =>
    value === "admin" ? [] : [{ value, label }],
  );
  function toggleRole(role: Capabilities["roles"][number]) {
    onChange({
      ...value,
      roles: value.roles.includes(role)
        ? value.roles.filter((selected) => selected !== role)
        : [...value.roles, role],
    });
  }
  return (
    <>
      <fieldset className="account-role-fields" disabled={disabled}>
        <legend>业务职责（可多选）</legend>
        {roles.map((role) => (
          <label key={role.value}>
            <input
              type="checkbox"
              checked={value.roles.includes(role.value)}
              onChange={() => toggleRole(role.value)}
            />
            {role.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="account-role-fields" disabled={disabled}>
        <legend>语言能力（可多选）</legend>
        {options.languageCapabilities.map((language) => (
          <label key={language.value}>
            <input
              type="checkbox"
              checked={value.languageCapabilities.includes(language.value)}
              onChange={() =>
                onChange({
                  ...value,
                  languageCapabilities: value.languageCapabilities.includes(
                    language.value,
                  )
                    ? value.languageCapabilities.filter(
                        (selected) => selected !== language.value,
                      )
                    : [...value.languageCapabilities, language.value],
                })
              }
            />
            {language.label}
          </label>
        ))}
      </fieldset>
    </>
  );
}
