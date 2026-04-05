const baseUrl =
  import.meta.env.VITE_API_BASE?.replace(/\/$/, '') ?? 'http://127.0.0.1:3001'

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}
