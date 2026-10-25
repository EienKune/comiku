import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
} from "react";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Check, ChevronDown, LoaderCircle, Search } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  leadingIcon,
  loading,
  className = "",
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle className="ui-spin" size={17} /> : leadingIcon}
      <span>{children}</span>
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md";
}

export function IconButton({
  label,
  size = "md",
  className = "",
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`ui-icon-button ui-icon-button--${size} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  startIcon?: ReactNode;
}

export function TextField({
  label,
  hint,
  error,
  startIcon,
  className = "",
  id,
  "aria-describedby": describedBy,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  return (
    <div className={`ui-field ${className}`}>
      {label && (
        <label className="ui-field__label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <span className={`ui-field__control ${error ? "is-error" : ""}`}>
        {startIcon}
        <input
          id={inputId}
          {...props}
          aria-invalid={error ? true : props["aria-invalid"]}
          aria-describedby={
            [describedBy, hint || error ? messageId : undefined]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
      </span>
      {(hint || error) && (
        <span
          id={messageId}
          className={error ? "ui-field__error" : "ui-field__hint"}
        >
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

export function SearchField(props: Omit<TextFieldProps, "startIcon">) {
  return <TextField startIcon={<Search size={17} />} {...props} />;
}

interface SelectControlProps {
  id?: string;
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  children: ReactNode;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

interface SelectFieldProps extends SelectControlProps {
  label?: string;
  hint?: string;
}

interface SelectOption {
  value: string;
  label: ReactNode;
  disabled: boolean;
  group?: string;
}

function optionText(value: ReactNode): string {
  return Children.toArray(value)
    .map((item) =>
      typeof item === "string" || typeof item === "number" ? item : "",
    )
    .join("");
}

function selectOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  function append(nodes: ReactNode, group?: string) {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === "option") {
        const element = child as ReactElement<{
          value?: string | number;
          disabled?: boolean;
          children?: ReactNode;
        }>;
        options.push({
          value: String(
            element.props.value ?? optionText(element.props.children),
          ),
          label: element.props.children,
          disabled: Boolean(element.props.disabled),
          group,
        });
      } else if (child.type === "optgroup") {
        const element = child as ReactElement<{
          label?: string;
          children?: ReactNode;
        }>;
        append(element.props.children, element.props.label);
      }
    });
  }
  append(children);
  return options;
}

export function SelectControl({
  children,
  className = "",
  id,
  value,
  defaultValue,
  onValueChange,
  disabled,
  required,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: SelectControlProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const listboxId = `${controlId}-listbox`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const options = selectOptions(children);
  const [internalValue, setInternalValue] = useState(() =>
    String(defaultValue ?? options[0]?.value ?? ""),
  );
  const selectedValue = value === undefined ? internalValue : String(value);
  const selectedIndex = options.findIndex(
    (option) => option.value === selectedValue,
  );
  const selected = options[selectedIndex];
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, selectedIndex),
  );

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  function choose(option: SelectOption) {
    if (option.disabled) return;
    setInternalValue(option.value);
    onValueChange?.(option.value);
    setOpen(false);
  }

  function moveActive(direction: 1 | -1) {
    if (!options.length) return;
    let next = activeIndex;
    do {
      next = (next + direction + options.length) % options.length;
    } while (options[next]?.disabled && next !== activeIndex);
    setActiveIndex(next);
  }

  return (
    <span
      ref={rootRef}
      className={`ui-field__control ui-field__select ${open ? "is-open" : ""} ${className}`}
    >
      {name && <input type="hidden" name={name} value={selectedValue} />}
      <button
        id={controlId}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-required={required || undefined}
        aria-activedescendant={
          open && options[activeIndex]
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        disabled={disabled}
        onClick={() => {
          setActiveIndex(Math.max(0, selectedIndex));
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              setActiveIndex(Math.max(0, selectedIndex));
            } else {
              moveActive(event.key === "ArrowDown" ? 1 : -1);
            }
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open && options[activeIndex]) choose(options[activeIndex]);
            else setOpen(true);
          } else if (event.key === "Escape") {
            setOpen(false);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
          }
        }}
      >
        <span className={selectedValue ? "" : "is-placeholder"}>
          {selected?.label ?? "请选择"}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <span className="ui-select-menu" id={listboxId} role="listbox">
          {options.map((option, index) => {
            const showGroup =
              option.group && options[index - 1]?.group !== option.group;
            return (
              <span
                className="ui-select-menu__item"
                key={`${option.value}-${index}`}
              >
                {showGroup && (
                  <span className="ui-select-menu__group">{option.group}</span>
                )}
                <button
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === selectedValue}
                  className={activeIndex === index ? "is-active" : ""}
                  disabled={option.disabled}
                  onPointerEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  {option.value === selectedValue && (
                    <Check size={15} aria-hidden="true" />
                  )}
                </button>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

export function SelectField({
  label,
  hint,
  children,
  className = "",
  id,
  "aria-describedby": describedBy,
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = `${selectId}-hint`;
  return (
    <div className={`ui-field ${className}`}>
      {label && (
        <label className="ui-field__label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <SelectControl
        id={selectId}
        {...props}
        aria-describedby={
          [describedBy, hint ? hintId : undefined].filter(Boolean).join(" ") ||
          undefined
        }
      >
        {children}
      </SelectControl>
      {hint && (
        <span className="ui-field__hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

type BadgeTone =
  | "neutral"
  | "translation"
  | "brand"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "violet";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

export function Badge({
  tone = "neutral",
  dot,
  className = "",
  children,
  ...props
}: BadgeProps) {
  return (
    <span className={`ui-badge ui-badge--${tone} ${className}`} {...props}>
      {dot && <span className="ui-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "article" | "div";
  variant?: "default" | "soft" | "outlined";
}

export function Surface({
  as: Element = "section",
  variant = "default",
  className = "",
  children,
  ...props
}: SurfaceProps) {
  return (
    <Element
      className={`ui-surface ui-surface--${variant} ${className}`}
      {...props}
    >
      {children}
    </Element>
  );
}

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      <div className="ui-empty-state__icon">{icon}</div>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}
