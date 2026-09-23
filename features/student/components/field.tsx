import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
type Props = {
  name: string;
  label: string;
  value?: string | number;
  type?: string;
  required?: boolean;
  options?: [string, string][];
  multiline?: boolean;
  error?: string;
  wide?: boolean;
  min?: number;
  max?: number;
  step?: number | string;
  autoComplete?: string;
};
export function Field({
  name,
  label,
  value,
  type = "text",
  required,
  options,
  multiline,
  error,
  wide,
  min,
  max,
  step,
  autoComplete,
}: Props) {
  const props = {
    id: name,
    name,
    defaultValue: value,
    required,
    "aria-invalid": !!error,
    "aria-describedby": error ? `${name}-error` : undefined,
  };
  return (
    <div className={`field ${wide ? "form-wide" : ""}`}>
      <label htmlFor={name}>{label}</label>
      {options ? (
        <NativeSelect {...props}>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </NativeSelect>
      ) : multiline ? (
        <Textarea {...props} rows={3} maxLength={5000} />
      ) : (
        <Input
          {...props}
          type={type}
          min={min}
          max={max}
          step={step}
          autoComplete={autoComplete}
        />
      )}
      {error && (
        <p id={`${name}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}
