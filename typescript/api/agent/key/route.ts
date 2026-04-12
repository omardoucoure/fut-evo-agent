import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const appToken = request.headers.get("x-app-token");
  const expectedToken = process.env.APP_SECRET_TOKEN;

  if (!expectedToken || appToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return NextResponse.json(
      { error: "API key not configured" },
      { status: 500 }
    );
  }

  return NextResponse.json({ key: openaiKey });
}
