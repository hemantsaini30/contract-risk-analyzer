export default function SeverityBadge({ level }) {
  return <span className={`badge sev-${level}`}>{level}</span>;
}
