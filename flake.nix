{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" "x86_64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        pkgs = import nixpkgs { inherit system; };
      });
    in {
      devShells = forAllSystems ({ pkgs }: {
        default = pkgs.mkShell {
          buildInputs = with pkgs; [
            go
            gopls
            sqlite
          ];
        };
      });

      packages = forAllSystems ({ pkgs }: {
        default = pkgs.buildGoModule {
          pname = "mercury";
          version = "0.1.0";
          src = ./.;
          vendorHash = "sha256-qOWInVJQ9t9rODdzpKeVeFhJhuR3gEa76TV1g9OD/lg=";
        };
      });
    };
}
