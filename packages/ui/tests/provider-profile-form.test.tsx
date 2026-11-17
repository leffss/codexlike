// @vitest-environment jsdom
// Provider Profile 表单模型区（ADR 0024 动态行）：SSR 静态断言测不到行增删与
// 排序交互，此处用 jsdom + testing-library 驱动真实点击，锁定「动态行可增删、
// 可上下移、首行带『默认』角标、空/重复模型名被校验拦截」的外部行为。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { ProviderProfileForm } from "../src/components/ProviderProfileForm";

const baseInput = {
  name: "GLM",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "sk-test",
};

function rowInputs(): HTMLInputElement[] {
  return screen
    .getAllByRole("textbox")
    .filter((node) =>
      node.getAttribute("aria-label")?.startsWith("模型")
    ) as HTMLInputElement[];
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
}

afterEach(cleanup);

describe("ProviderProfileForm 模型区（动态行）", () => {
  it("单模型 initial 渲染一行，首行带「默认」角标", () => {
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );

    expect(rowInputs()).toHaveLength(1);
    expect(rowInputs()[0]?.value).toBe("glm-4.7");
    expect(screen.getByText("默认")).toBeTruthy();
    expect(screen.queryByText("模型 2")).toBeNull();
  });

  it("多模型 initial 逐行渲染，角标只在首行", () => {
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7", "glm-4.6"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );

    expect(rowInputs().map((input) => input.value)).toEqual([
      "glm-4.7",
      "glm-4.6",
    ]);
    expect(screen.getAllByText("默认")).toHaveLength(1);
  });

  it("「添加模型」追加空行；删除按钮移除所在行", () => {
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    expect(rowInputs()).toHaveLength(2);
    expect(rowInputs()[1]?.value).toBe("");

    fireEvent.click(
      screen.getAllByRole("button", { name: "删除" })[1] as HTMLElement
    );
    expect(rowInputs().map((input) => input.value)).toEqual(["glm-4.7"]);
  });

  it("上移/下移调整顺序，角标跟随新的首行", () => {
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7", "glm-4.6", "glm-4.5"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );

    // 第二行上移到首位
    fireEvent.click(
      screen.getAllByRole("button", { name: "上移" })[1] as HTMLElement
    );
    expect(rowInputs().map((input) => input.value)).toEqual([
      "glm-4.6",
      "glm-4.7",
      "glm-4.5",
    ]);

    // 首行下移
    fireEvent.click(
      screen.getAllByRole("button", { name: "下移" })[0] as HTMLElement
    );
    expect(rowInputs().map((input) => input.value)).toEqual([
      "glm-4.7",
      "glm-4.6",
      "glm-4.5",
    ]);
  });

  it("首行不能继续上移、末行不能继续下移（按钮禁用）", () => {
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7", "glm-4.6"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={async () => {}}
      />
    );

    const upButtons = screen.getAllByRole("button", {
      name: "上移",
    }) as HTMLButtonElement[];
    const downButtons = screen.getAllByRole("button", {
      name: "下移",
    }) as HTMLButtonElement[];
    expect(upButtons[0]?.disabled).toBe(true);
    expect(upButtons[1]?.disabled).toBe(false);
    expect(downButtons[0]?.disabled).toBe(false);
    expect(downButtons[1]?.disabled).toBe(true);
  });

  it("空模型名提交被拦截，提示与现有表单错误风格一致", async () => {
    const onSubmit = vi.fn();
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    submit();

    expect(await screen.findByText("模型名称不能为空")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("重复模型名提交被拦截（trim 后比较）", async () => {
    const onSubmit = vi.fn();
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(rowInputs()[1] as HTMLElement, {
      target: { value: " glm-4.7 " },
    });
    submit();

    expect(await screen.findByText("模型名称不能重复")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("行删光后提交被拦截（列表至少一项）", async () => {
    const onSubmit = vi.fn();
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    submit();

    expect(await screen.findByText("请至少添加一个模型")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("合法多模型提交把 models 数组按行序交给 onSubmit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ProviderProfileForm
        initial={{ ...baseInput, models: ["glm-4.7"] }}
        submitLabel="创建"
        onCancel={() => {}}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
    fireEvent.change(rowInputs()[1] as HTMLElement, {
      target: { value: "glm-4.6" },
    });
    submit();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: "GLM",
      models: ["glm-4.7", "glm-4.6"],
    });
  });
});
