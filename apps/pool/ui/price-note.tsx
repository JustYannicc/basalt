import { StateIcon } from "./controls.tsx";
import { priceNoteLines, priceTitle, type Price } from "./price-text.ts";

/** The short note a row shows under its amount, or nothing for refreshed live rates. */
export function PriceNote({ price, start = false }: { price: Price | null; start?: boolean }) {
  const note = priceNoteLines(price);
  if (!price || !note) return null;
  return (
    <span
      title={priceTitle(price)}
      className={`mt-0.5 grid text-xs leading-snug font-normal whitespace-nowrap ${start ? "justify-items-start" : "justify-items-end"} ${note.failed ? "text-warning" : "text-muted-foreground"}`}
    >
      {note.lines.map((line, index) => (
        <span key={line} className={index > 0 ? "text-muted-foreground" : undefined}>
          {note.failed && index === 0 && (
            <StateIcon tone="warn" className="mr-1 inline-block size-3 align-[-1px]" />
          )}
          {line}
        </span>
      ))}
    </span>
  );
}
