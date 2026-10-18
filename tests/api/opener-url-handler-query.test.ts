import { expect, test } from "bun:test";
import {
  type AssociationCall,
  MAX_HANDLER_TEXT_UNITS,
  readAssociationString,
  resolveUrlHandler,
} from "#plugins/opener/src/platforms/windows-handler-query";

const S_OK = 0;
const S_FALSE = 1;
const ERROR_NO_ASSOCIATION = 0x80070483 | 0;
const ERROR_FILE_NOT_FOUND = 0x80070002 | 0;
const ERROR_MORE_DATA = 0x800700ea | 0;
const E_FAIL = 0x80004005 | 0;

type Step = {
  result: number;
  units?: number;
  text?: string;
};

/** Replay scripted calls: even calls are length queries and odd calls fill the buffer. */
function scripted(steps: Step[]): {
  call: AssociationCall;
  calls: () => number;
} {
  let index = 0;
  return {
    calls: () => index,
    call(output, units) {
      const step = steps[index++];
      if (!step) {
        throw new Error("Unexpected extra AssocQueryStringW call.");
      }
      if (output !== null && step.text !== undefined) {
        output.write(`${step.text}\0`, "utf16le");
      }
      return {
        result: step.result,
        units: step.units ?? units,
      };
    },
  };
}

const lengthOf = (text: string) => text.length + 1;
const success = (text: string): Step[] => [
  {
    result: S_FALSE,
    units: lengthOf(text),
  },
  {
    result: S_OK,
    text,
  },
];

test("a successful query returns the text up to the NUL", () => {
  expect(readAssociationString(scripted(success("Browser")).call)).toBe(
    "Browser",
  );
});

test("failed HRESULTs are all no handler, whichever code they carry", () => {
  for (const result of [
    ERROR_NO_ASSOCIATION,
    ERROR_FILE_NOT_FOUND,
    E_FAIL,
  ]) {
    expect(
      readAssociationString(
        scripted([
          {
            result,
          },
        ]).call,
      ),
    ).toBeNull();
    expect(
      readAssociationString(
        scripted([
          {
            result: S_FALSE,
            units: 8,
          },
          {
            result,
          },
        ]).call,
      ),
    ).toBeNull();
  }
});

test("empty, oversized and control-character results are no handler", () => {
  expect(readAssociationString(scripted(success("")).call)).toBeNull();
  expect(
    readAssociationString(
      scripted([
        {
          result: S_FALSE,
          units: 0,
        },
      ]).call,
    ),
  ).toBeNull();
  expect(
    readAssociationString(
      scripted([
        {
          result: S_FALSE,
          units: MAX_HANDLER_TEXT_UNITS + 1,
        },
      ]).call,
    ),
  ).toBeNull();
  expect(
    readAssociationString(scripted(success("Brow\u0007ser")).call),
  ).toBeNull();
});

test("a size change is retried once and then reported as no handler", () => {
  const recovered = scripted([
    {
      result: S_FALSE,
      units: 3,
    },
    {
      result: ERROR_MORE_DATA,
    },
    ...success("Browser"),
  ]);
  expect(readAssociationString(recovered.call)).toBe("Browser");
  const repeated = scripted([
    {
      result: S_FALSE,
      units: 3,
    },
    {
      result: ERROR_MORE_DATA,
    },
    {
      result: S_FALSE,
      units: 3,
    },
    {
      result: ERROR_MORE_DATA,
    },
  ]);
  expect(readAssociationString(repeated.call)).toBeNull();
  expect(repeated.calls()).toBe(4);
});

test("a handler needs both name and path", () => {
  expect(
    resolveUrlHandler(
      () => "Browser",
      () => "C:\\Browser\\browser.exe",
    ),
  ).toEqual({
    name: "Browser",
    path: "C:\\Browser\\browser.exe",
  });
  expect(
    resolveUrlHandler(
      () => null,
      () => {
        throw new Error("path must not be read without a name");
      },
    ),
  ).toBeNull();
  expect(
    resolveUrlHandler(
      () => "Browser",
      () => null,
    ),
  ).toBeNull();
});
