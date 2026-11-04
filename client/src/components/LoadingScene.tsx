import { useState } from 'react';
import './LoadingScene.css';

type Props = {
  label: string;
  detail?: string;
  compact?: boolean;
  progress?: { completed: number; total: number };
};

// Decorative vector artwork stays local and never becomes an activity image.
function LittleThinker() {
  return <svg className="ska-loading-scene__art" viewBox="0 0 160 144" aria-hidden="true" focusable="false">
    <ellipse cx="77" cy="131" rx="57" ry="7" fill="#DDEAE7" />
    <circle cx="55" cy="69" r="43" fill="#E4F2EE" />
    <path d="m24 43 3-6 3 6 6 3-6 3-3 6-3-6-6-3Z" fill="#E6B551" />
    <circle cx="26" cy="90" r="3" fill="#B7D8CE" />
    <path d="m130 95 3-6 3 6 6 3-6 3-3 6-3-6-6-3Z" fill="#AA99D9" />
    <g className="ska-loading-scene__child">
      <path d="M49 120v-8c0-17 14-25 30-25s29 8 29 25v8Z" fill="#F4CB63" stroke="#37495D" strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M76 99v12m7-12v12" stroke="#D2A43D" strokeWidth="2" strokeLinecap="round" />
      <g className="ska-loading-scene__head">
        <circle cx="51" cy="71" r="7" fill="#E3AE8C" stroke="#37495D" strokeWidth="2.5" />
        <circle cx="107" cy="71" r="7" fill="#E3AE8C" stroke="#37495D" strokeWidth="2.5" />
        <rect x="51" y="38" width="57" height="62" rx="28" fill="#F2C4A2" stroke="#37495D" strokeWidth="2.5" />
        <path d="M51 64c-5-12 0-27 11-30 0-8 13-10 19-5 9-8 22-2 22 6 11 2 14 17 5 27l-6-13c-11 5-23 1-28-6-4 10-12 14-20 13Z" fill="#37495D" stroke="#37495D" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M63 65q5-3 10 0m15-1q5-3 10 0" stroke="#37495D" strokeWidth="2" strokeLinecap="round" fill="none" />
        <g className="ska-loading-scene__eyes">
          <ellipse cx="69" cy="73" rx="2.4" ry="3.3" fill="#37495D" />
          <ellipse cx="93" cy="72" rx="2.4" ry="3.3" fill="#37495D" />
        </g>
        <ellipse cx="62" cy="81" rx="5" ry="3" fill="#EB9D87" opacity=".65" />
        <ellipse cx="99" cy="80" rx="5" ry="3" fill="#EB9D87" opacity=".65" />
        <path d="m80 75-2 6h4m-8 7q7 5 14-1" fill="none" stroke="#9B5D4C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <path d="M53 114c4-2 9-6 12-13l6 4c-2 9-7 15-13 16" fill="#F2C4A2" stroke="#37495D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M64 102c-1-4 2-7 5-7h5c3 0 4 3 2 5l-5 6" fill="#F2C4A2" stroke="#37495D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M104 114c-6-5-9-10-10-16l-8 2c0 10 4 17 10 21" fill="#F2C4A2" stroke="#37495D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M85 100c-4-1-5-5-2-7l7-5c2-2 5 0 4 3l-1 7" fill="#F2C4A2" stroke="#37495D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <path d="m27 115 48 4 49-4v13l-49 5-48-5Z" fill="#718FCC" stroke="#37495D" strokeWidth="2.5" strokeLinejoin="round" />
    <path d="M75 119c-13-9-29-11-48-10v15c18-1 33 2 48 7 15-5 32-8 49-7v-15c-19-1-36 1-49 10Z" fill="#FFFCF1" stroke="#37495D" strokeWidth="2.5" strokeLinejoin="round" />
    <path d="M75 120v10m-37-13 22 4m30 0 22-4" stroke="#C3CFD9" strokeWidth="2" strokeLinecap="round" />
    <g className="ska-loading-scene__thought">
      <circle cx="113" cy="55" r="3" fill="#FFF" stroke="#A999D0" strokeWidth="1.5" />
      <circle cx="118" cy="46" r="4" fill="#FFF" stroke="#A999D0" strokeWidth="1.5" />
      <path d="M108 24c-2-9 7-16 15-13 6-6 17-2 18 5 10 0 14 13 6 19-1 9-14 12-20 6-9 4-20-3-17-11-3-1-3-4-2-6Z" fill="#FFF" stroke="#A999D0" strokeWidth="2" />
      <g className="ska-loading-scene__idea ska-loading-scene__idea--star">
        <path d="m129 18 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" fill="#F4CB63" stroke="#B78A32" strokeWidth="1.5" strokeLinejoin="round" />
      </g>
      <g className="ska-loading-scene__idea ska-loading-scene__idea--pencil">
        <path d="m120 32 4-7 10-9 5 5-10 10-9 3Z" fill="#F4CB63" stroke="#8B6D35" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="m124 25 5 6m-9 3 2-5m12-13 5 5" stroke="#8B6D35" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M121 38h17" stroke="#A999D0" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      <g className="ska-loading-scene__idea ska-loading-scene__idea--blocks">
        <rect x="119" y="27" width="10" height="10" rx="2" fill="#87BAAE" stroke="#4E8176" strokeWidth="1.5" />
        <rect x="130" y="27" width="10" height="10" rx="2" fill="#AFA0D9" stroke="#7B68AE" strokeWidth="1.5" />
        <rect x="125" y="16" width="10" height="10" rx="2" fill="#F4CB63" stroke="#B78A32" strokeWidth="1.5" />
      </g>
    </g>
  </svg>;
}

export function LoadingScene({ label, detail, compact = false, progress }: Props) {
  const [moving, setMoving] = useState(true);
  const total = progress && Number.isSafeInteger(progress.total) && progress.total > 0 ? progress.total : null;
  const completed = total !== null && progress && Number.isSafeInteger(progress.completed)
    ? Math.max(0, Math.min(total, progress.completed)) : null;
  return <div className={'ska-loading-scene' + (compact ? ' is-compact' : '') + (!moving ? ' is-paused' : '')}>
    <div className="ska-loading-scene__visual" aria-hidden="true"><LittleThinker /></div>
    <div className="ska-loading-scene__content">
      <div role="status" aria-live="polite" aria-atomic="true">
        <p className="ska-loading-scene__label">{label}</p>
        {detail && <p className="ska-loading-scene__detail">{detail}</p>}
      </div>
      {total !== null && completed !== null && <div className="ska-loading-scene__progress">
        <progress aria-label="Task progress" max={total} value={completed} />
        <span>{completed} of {total} complete</span>
      </div>}
      {!compact && <button className="ska-loading-scene__toggle" type="button" onClick={() => setMoving(value => !value)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          {moving ? <path d="M5 3v10M11 3v10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /> : <path d="m5 2 8 6-8 6Z" fill="currentColor" />}
        </svg>
        {moving ? 'Pause animation' : 'Resume animation'}
      </button>}
    </div>
  </div>;
}
