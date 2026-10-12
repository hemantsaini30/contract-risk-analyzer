/** Renders text with the evidence quote highlighted (offsets come from the server's verification step). */
export default function Highlight({ text = '', start, end }) {
  if (start == null || end == null) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}
