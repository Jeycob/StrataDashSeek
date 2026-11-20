# Native Code – OSS

The Code – OSS tab in the Native right sidebar opens the browser workbench on the selected conversation’s project in host-compatible mode. It uses the same project file operations, sandbox policy, writer lease and version checks as the Native file tools. The built-in HomeAI extension registers the conversation’s virtual workspace. Live updates cover the open text editors and recently listed Explorer directories. Text editing supports UTF-8 files up to 1 MiB.

The standard `npm ci --prefix runtime` installs the published, integrity-locked `@github1s/vscode-web@0.30.3` distribution. Native serves the bundle locally and uses the current interface language when opening or reloading the workbench. Updating an installed runtime requires building it again from the updated lockfile.

- [GitHub1s source revision](https://github.com/conwnet/github1s/tree/74e37d455738efc9b7bfd4e1015ffa4ab35eb8d9) and [included MIT license](LICENSE-GitHub1s.txt).
- [Code – OSS 1.132.1](https://github.com/microsoft/vscode/tree/1.132.1), [included MIT license](LICENSE-Code-OSS.txt) and [third-party notices](ThirdPartyNotices.txt).
