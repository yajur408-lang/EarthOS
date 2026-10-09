import { useRef } from 'react'
import Icon from './Icon'

/** Shows the generated report in-app; printing the frame gives "Save as PDF" without needing pop-ups. */
export default function ReportView({ html, onDownload, onClose }: { html: string; onDownload: () => void; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="report" role="dialog" aria-modal="true" aria-label="Report preview" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Report</h2>
          <span />
          <button className="btn" onClick={onDownload}><Icon name="download" size={18} /> Download .html</button>
          <button className="btn primary" onClick={() => frame.current?.contentWindow?.print()}>Save as PDF / Print</button>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <iframe ref={frame} title="Report" srcDoc={html} />
        <p className="hint">In the print dialog, choose "Save as PDF" as the destination.</p>
      </div>
    </div>
  )
}
