type Props = {
  title: string
  subtitle?: string
  svg: string
  filename: string
}

export function SvgPane({ title, subtitle, svg, filename }: Props) {
  const download = () => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="pane">
      <header className="pane__head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="pane__sub">{subtitle}</p>}
        </div>
        <button type="button" className="btn btn--ghost" onClick={download}>
          SVG を保存
        </button>
      </header>
      {/* svg はすべて自前の render.ts が生成したもの（外部入力を素通ししない） */}
      <div className="pane__canvas" dangerouslySetInnerHTML={{ __html: svg }} />
    </section>
  )
}
