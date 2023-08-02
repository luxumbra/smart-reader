import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import ethers from "ethers";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../../lib/database.types.ts";
import jwt from "jsonwebtoken";

const SUPABASE_TABLE_USERS = "users";

function createErrorResponse(errorMessage: string, statusCode = 400) {
    console.log(errorMessage);
    return new Response(
        JSON.stringify({
            error: errorMessage,
        }),
        {
            headers: { "Content-Type": "application/json" },
            status: statusCode,
        }
    );
}

serve(async (req) => {
    const { address, signedMessage, nonce } = await req.json();

    //1. verify the signed message matches the requested address
    const message = `I am signing this message to authenticate my address with my account on Smart Reader. Nonce: ${nonce}`;

    const signerAddress = ethers.verifyMessage(message, signedMessage);

    // now you can compare the signer's address to the expected address
    if (signerAddress === address) {
        console.log("The message was signed by the expected address.");
    } else {
        return createErrorResponse(
            "The message was NOT signed by the expected address."
        );
    }
    //2. select * from public.user table where address matches
    const supabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") as string,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") as string // service role key required for row creation/editing
    );
    const { data } = await supabase
        .from(SUPABASE_TABLE_USERS)
        .select()
        .eq("address", address)
        .single();
    if (data == null) {
        return createErrorResponse("The public user does not exist.");
    }
    //3. verify the nonce included in the request matches what's already in public.users table for that address
    if (data?.auth.genNonce !== nonce) {
        return createErrorResponse("The nonce does not match.");
    }
    // 4. if there's no public.users.id for that address, then you need to create a user in the auth.users table
    let authUser;
    if (!data?.id) {
        const { data: userData, error } = await supabase.auth.admin.createUser({
            // email: `user@email.com`,
            user_metadata: { address: address },
        });
        if (error) {
            return createErrorResponse(error.message);
        }
        if (data.user != null) {
            authUser = userData.user;
        }
    } else {
        const { data: userData, error } = await supabase.auth.admin.getUserById(
            data.id
        );

        if (error) {
            return createErrorResponse(error.message);
        } else {
            authUser = userData.user;
        }
    }

    // const
    // 5. insert response into public.users table with id
    let newNonce = Math.floor(Math.random() * 1000000);
    while (newNonce === nonce) {
        newNonce = Math.floor(Math.random() * 1000000);
    }

    await supabase
        .from(SUPABASE_TABLE_USERS)
        .update({
            auth: {
                genNonce: newNonce, // update the nonce, so it can't be reused
                lastAuth: new Date().toISOString(),
                lastAuthStatus: "success",
            },
            id: authUser?.id, // same uuid as auth.users table
        })
        .eq("address", address); // primary key

    // 6. lastly, we sign the token, then return it to client
    const token = jwt.sign(
        { address: address },
        Deno.env.get("JWT_SECRET") as string
    );
    const cookie = `mytoken=${token}; Path=/;`;
    return new Response(null, {
        headers: { "Set-Cookie": cookie },
    });
});
