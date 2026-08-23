import { NextResponse } from "next/server";
import {
  applySectionOverrides,
  createVersion,
  getDefaultSystemPromptSections,
  readRoleSystemPromptConfig,
  readVersions,
  writeRoleSystemPromptConfig,
} from "@/lib/system-prompt-decomposer";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

function roleIdFromUrl(req: Request): string {
  return new URL(req.url).searchParams.get("roleId") || "default";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const roleId = url.searchParams.get("roleId") || "default";
  const cwd = url.searchParams.get("cwd");

  const config = readRoleSystemPromptConfig(roleId);
  const sections = applySectionOverrides(getDefaultSystemPromptSections(cwd), config.sections);

  // Load available skills for the current project
  let availableSkills: { name: string; description: string; disabled: boolean }[] = [];
  if (cwd) {
    try {
      const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
      await loader.reload();
      const { skills } = loader.getSkills();
      availableSkills = skills.map((s) => ({
        name: s.name,
        description: s.description,
        disabled: Boolean(s.disableModelInvocation),
      }));
    } catch { /* skills unavailable */ }
  }

  return NextResponse.json({
    roleId,
    sections,
    config: { ...config, skillNames: config.skillNames ?? null, mcpToolNames: config.mcpToolNames ?? null },
    availableSkills,
    versions: readVersions(roleId),
  });
}

export async function PATCH(req: Request) {
  const roleId = roleIdFromUrl(req);
  try {
    const body = await req.json() as {
      sections?: { id: string; enabled: boolean; content: string }[];
      skillNames?: string[] | null;
      mcpToolNames?: string[] | null;
      activeVersionId?: string | null;
    };

    const config = writeRoleSystemPromptConfig(roleId, {
      sections: body.sections ?? [],
      skillNames: body.skillNames,
      mcpToolNames: body.mcpToolNames,
      activeVersionId: body.activeVersionId ?? null,
    });

    return NextResponse.json({ roleId, config });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const roleId = roleIdFromUrl(req);
  try {
    const body = await req.json() as {
      name?: string;
      description?: string;
      sections?: { id: string; enabled: boolean; content: string }[];
      makeActive?: boolean;
    };

    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const version = createVersion({
      roleId,
      name: body.name,
      description: body.description,
      sections: body.sections ?? [],
    });

    let config = readRoleSystemPromptConfig(roleId);
    if (body.makeActive) {
      config = writeRoleSystemPromptConfig(roleId, {
        sections: version.sections,
        skillNames: config.skillNames,
        mcpToolNames: config.mcpToolNames,
        activeVersionId: version.id,
      });
    }

    return NextResponse.json({ roleId, version, config });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
